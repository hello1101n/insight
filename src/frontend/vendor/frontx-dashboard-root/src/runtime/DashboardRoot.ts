import { GtsPlugin } from '@gears-frontx/gts-plugin';
import type { MfeRegistry, TypeSystemPlugin } from '@gears-frontx/mfes';

import {
  LANGUAGE_PROPERTY_ID,
  RENDER_WIDGET_ACTION_ID,
  THEME_PROPERTY_ID,
  WIDGETS_DOMAIN_ID,
  type Dashboard,
  type WidgetInstance,
} from '../contract';
import { CellFailure, RequestFailed, SharedRequests, formOf, runBinding, type Binding, type BindingResult, type VariableValues } from './binding';
import { withTimeout, type DashboardHost } from './host';
import { extensionIdOf, renderStampIdOf, stampIdOf, type Role } from './ids';
import { effectiveTraits, escapeControls, registerBundle, registerDashboard, registerServedFile, renderTypeOf, typeOfWidget, type FileOutcome } from './register';
import { createWidgetsRegistry, WidgetEntryHandler, type WidgetEntries } from './registry';

/*
 * The dashboard root of the single-page hosting form: one registry with the
 * `widgets` domain, the served file and the dashboards it loaded, and the
 * flow of every cell (runtime FEATURE "Open a dashboard"). A product creates
 * one root and renders `<Dashboard root={...} />` wherever a dashboard shows;
 * one `Dashboard` at a time per root (DESIGN §2.2, one root per registry).
 */

export type LoadOutcome = { ok: true; dashboard: Dashboard; failed: ReadonlyMap<string, string> } | { ok: false };

/**
 * What a cell shows; the root reports each change to the cell's frame. `placing`: the data is ready and the cell lays out the widget's container, still under its loader, before `render_widget` goes out.
 * `retry` is true on a cannot-be-shown state that came from a failed data request (`RequestFailed`): the frame offers a retry.
 */
export type CellUpdate = { state: 'loading' | 'placing' | 'shown' | 'cannot-be-shown'; retry?: boolean } | { container: HTMLElement; placed: () => void };

/**
 * A running cell: `leave` unmounts its extension; `rerun` runs its binding again with new variable values; `ended` is
 * true once the cell failed before its extension was ready or its `render_widget` fell back, so it sends no request.
 * `requestFailed` is true while the cell's last run ended in a failed data request; `source` is the shared request
 * its binding reads, if any; `waitsOn` is true when the newest run awaited this held answer of it, whether or not it
 * has reported the result yet. A retry is a `rerun` with the current values.
 */
export interface CellRun {
  leave: () => void;
  rerun: (values: VariableValues) => void;
  ended: () => boolean;
  requestFailed: () => boolean;
  waitsOn: (answer: Promise<unknown>) => boolean;
  source?: string;
}

/** How long the root waits for a cell to take its widget's container before it sends `render_widget` anyway. */
const PLACE_TIMEOUT_MS = 2_000;

export interface DashboardRootOptions {
  /** Answers the root's dashboard and data requests (`fetchHost` for a same-origin API). */
  host: DashboardHost;
  /** The page origin binding paths resolve against; the current page's by default. */
  origin?: string;
  /**
   * The origins widget bundles may load from: the page origin by default. A
   * bundle on another origin (a CDN) loads only when its origin is listed here
   * and that server allows the page origin by CORS (DESIGN §3.5).
   */
  bundleOrigins?: readonly string[];
  /**
   * Tests only: widget entries loaded from the product's own bundle instead
   * of their widget bundles, by entry id (`WIDGET_ENTRIES` from
   * `@gears-frontx/frontx-dashboard-widgets/testing`).
   */
  entries?: WidgetEntries;
}

const MOUNT_TIMEOUT_MS = 30_000;

/**
 * Fields the type store (gts-ts 0.11) reads as an entity's id or schema before `id`; transform output must not
 * carry them. No catalog data type has a top-level field of these names, so valid data never does.
 */
const GTS_IDENTITY_FIELDS = ['$id', 'gtsId', 'gtsIid', 'gtsOid', 'gtsI', 'gts_id', 'gts_oid', 'gts_iid', '$schema', 'gtsTid', 'gtsType', 'gtsT', 'gts_t', 'gts_tid', 'gts_type', 'type', 'schema'];

/**
 * Top-level render fields the type store (gts-ts 0.11) reads as the instance's identity or as a schema marker, and `id`,
 * which the root stamps: a render carrying one would register under another id or not as an instance at all. The type
 * names (`type`, `schema`, `gtsType` and their kin) are not here: the store validates a render that carries one against
 * the stamp's render type, which judges it like any other field.
 */
export const RENDER_RESERVED_FIELDS = ['id', '$id', 'gtsId', 'gtsIid', 'gtsOid', 'gtsI', 'gts_id', 'gts_oid', 'gts_iid', '$schema'];

/** An allowed bundle origin as the check compares it: a base address such as `https://cdn.example.com/widgets/` counts as its origin. */
const originOf = (address: string): string[] => {
  try {
    const url = new URL(address);
    // Bundles load over http(s) only; any other value (data:, file:, a bare host name) allows nothing.
    return url.protocol === 'https:' || url.protocol === 'http:' ? [url.origin] : [];
  } catch {
    return [];
  }
};

export class DashboardRoot {
  readonly types: TypeSystemPlugin;
  /** Absent when the registry rejected the `widgets` domain: a failed start, with no exit. */
  readonly registry?: MfeRegistry;
  readonly host: DashboardHost;
  readonly origin: string;
  private readonly bundleIds: Set<string>;
  private readonly containers = new Map<string, HTMLElement>();
  private readonly mountWaiters = new Map<string, Set<(error?: unknown) => void>>();
  private readonly leaving = new Set<string>();
  private readonly renderFallbacks = new Map<string, () => void>();
  private file?: Promise<FileOutcome>;
  private readonly loads = new Map<string, Promise<LoadOutcome>>();
  /** The generated extensions registered for each dashboard id. */
  private readonly extensions = new Map<string, Set<string>>();
  /** The last theme id and language the `widgets` domain accepted, each on its own. */
  private readonly published: { theme?: string; language?: string } = {};
  /** The release still running for a dashboard id. */
  private readonly releasing = new Map<string, Promise<void>>();

  constructor({ host, entries = {}, origin = globalThis.location?.origin ?? '', bundleOrigins = [origin] }: DashboardRootOptions) {
    this.host = host;
    this.origin = origin;
    this.types = new GtsPlugin({ isolated: true });
    this.bundleIds = registerBundle(this.types);
    try {
      this.registry = createWidgetsRegistry(this.types, new WidgetEntryHandler(entries, new Set(bundleOrigins.flatMap(originOf))), this.containers, {
        mounted: (id, error) => {
          // A fresh mount ends any leave the root asked for earlier and whose unmount never ran.
          this.leaving.delete(id);
          for (const waiter of [...(this.mountWaiters.get(id) ?? [])]) waiter(error ?? undefined);
        },
        unmounted: (id) => {
          if (this.leaving.delete(id)) return;
          // The root did not ask for this unmount: it is the fallback of a `render_widget` chain.
          this.renderFallbacks.get(id)?.();
        },
      });
    } catch (error) {
      console.error(`[dashboard] the registry rejected the widgets domain: ${String(error)}`);
    }
  }

  /** Attaches the element under which the domain places the widget containers before a cell takes them. */
  attach(element: HTMLElement | null): void {
    if (element) this.registry?.getMounter(WIDGETS_DOMAIN_ID).attach(element);
  }

  /** Publishes the host theme id and language on the `widgets` domain; a change restyles every widget and re-runs nothing. */
  publish(theme: string, language: string): void {
    this.publishOne('theme', THEME_PROPERTY_ID, theme);
    this.publishOne('language', LANGUAGE_PROPERTY_ID, language);
  }

  /**
   * Publishes one of the two properties. The host can pass anything; a value the property type rejects keeps the last
   * one of that property, never stops the other one and never breaks the render.
   */
  private publishOne(name: 'theme' | 'language', propertyId: string, value: string): void {
    if (!this.registry || this.published[name] === value) return;
    try {
      this.registry.updateSharedProperty(propertyId, value);
      this.published[name] = value;
    } catch (error) {
      console.error(`[dashboard] ${escapeControls(`the ${name} cannot be published: ${String(error).split('\n')[0]}`)}`);
    }
  }

  /** Loads a dashboard id: the served file once, then the dashboard's registrations. A failed load is retried on the next call. */
  load(dashboardId: string): Promise<LoadOutcome> {
    let load = this.loads.get(dashboardId);
    if (!load) {
      load = this.loadOnce(dashboardId);
      this.loads.set(dashboardId, load);
      const drop = () => {
        if (this.loads.get(dashboardId) === load) this.loads.delete(dashboardId);
      };
      // A rejected load is dropped too, so the bookkeeping never leaves an unhandled rejection behind.
      void load.then((outcome) => {
        if (!outcome.ok) drop();
      }, drop);
    }
    return load;
  }

  private async loadOnce(dashboardId: string): Promise<LoadOutcome> {
    const fail = (problem: string): LoadOutcome => {
      // A part may bring the dashboard and the ids the problem quotes, so the line is escaped as the part line is.
      console.error(`[dashboard] ${escapeControls(`dashboard ${dashboardId} cannot be shown: ${problem}`)}`);
      return { ok: false };
    };
    if (!this.registry) return fail('the widgets domain was rejected at start');
    this.file ??= withTimeout((signal) => this.host.loadFile(signal)).then(
      (file) => registerServedFile(this.types, file, this.bundleIds),
      (error) => ({ ok: false, problem: `the served file could not be loaded: ${String(error)}` }) as const,
    );
    let file: FileOutcome;
    try {
      file = await this.file;
    } catch (error) {
      // An answer the registration cannot even read: the file is dropped like a failed one, so the next load retries.
      file = { ok: false, problem: `the served file cannot be registered: ${String(error).split('\n').slice(0, 2).join(' ')}` };
    }
    if (!file.ok) {
      this.file = undefined;
      return fail(file.problem);
    }
    const dashboard = file.dashboards.get(dashboardId);
    if (!dashboard) return fail(`no dashboard ${dashboardId} in the served file`);
    let outcome: ReturnType<typeof registerDashboard>;
    try {
      outcome = registerDashboard(this.types, dashboard, file.rejected);
    } catch (error) {
      // A dashboard the registration cannot even read fails like a rejected one, so the next load retries.
      return fail(`the dashboard cannot be registered: ${String(error).split('\n').slice(0, 2).join(' ')}`);
    }
    if (!outcome.ok) return fail(outcome.problem);
    // Each failed widget is reported once, by its cell, when the cell runs. The cells run the copies read on load.
    return { ok: true, dashboard: outcome.dashboard, failed: outcome.failed };
  }

  /** Drops a load that has not settled, so the next mount of that id starts a new one (the owner state Loading to Started). */
  forget(dashboardId: string, load: Promise<LoadOutcome>): void {
    if (this.loads.get(dashboardId) === load) this.loads.delete(dashboardId);
  }

  /**
   * Unregisters the generated extensions of a dashboard the viewer left for
   * another one. A cell that starts before this finishes waits for it, so it
   * never reuses an extension about to be unregistered.
   */
  release(dashboardId: string): Promise<void> {
    const ids = this.extensions.get(dashboardId);
    this.extensions.delete(dashboardId);
    const before = this.releasing.get(dashboardId) ?? Promise.resolve();
    const done = before.then(async () => {
      for (const id of ids ?? []) {
        this.leaving.add(id);
        await this.registry?.unregisterExtension(id).catch(() => undefined);
        this.leaving.delete(id);
      }
    });
    this.releasing.set(dashboardId, done);
    void done.then(() => {
      if (this.releasing.get(dashboardId) === done) this.releasing.delete(dashboardId);
    });
    return done;
  }

  /**
   * The binding of a widget, or nothing: only a widget that registered and whose type's effective traits carry
   * `data_type` (a data widget) has one. A widget that failed its own registration may carry any `data`, and a widget
   * type outside `data_widget` has no data to deliver, so neither sends a request.
   */
  bindingOf(widget: WidgetInstance, failure: string | undefined): Binding | undefined {
    if (failure || widget.data === null || typeof widget.data !== 'object') return undefined;
    try {
      return effectiveTraits(this.types, typeOfWidget(widget.id)).data_type === undefined ? undefined : (widget.data as Binding);
    } catch {
      // A type that does not resolve fails the cell at its traits.
      return undefined;
    }
  }

  /**
   * Runs one cell or larger view: traits, extension, mount, binding, stamp,
   * `render_widget`. Every failure stays in this cell. Returns its `leave`, which unmounts the extension when the
   * cell leaves, and its `rerun`, which runs the binding again with new variable values and sends a new
   * `render_widget` with the data, the extension staying mounted. Each binding run holds a token: only the newest
   * run of a cell that is still there delivers, so an answer for an older value is dropped.
   */
  runCell({
    dashboardId,
    widget,
    role,
    failure,
    shared,
    values = {},
    update,
  }: {
    dashboardId: string;
    widget: WidgetInstance;
    role: Role;
    /** Set when the widget instance failed its own registration. */
    failure?: string;
    shared: SharedRequests;
    /** The current variable values. */
    values?: VariableValues;
    update: (change: CellUpdate) => void;
  }): CellRun {
    let live = true;
    let token = 0;
    /** Set once the extension is mounted: from then on a re-run delivers its own data. */
    let deliver: ((data: Promise<BindingResult>, run: number) => Promise<void>) | undefined;
    /** Set when the cell failed before its extension was ready, or its `render_widget` fell back: nothing re-runs then. */
    let ended = false;
    /** Set when the newest run ended in a failed data request; a new run clears it. */
    let requestFailed = false;
    /** The held shared answer the newest run awaits; a new run clears it. */
    let awaited: Promise<unknown> | undefined;
    let current = values;
    let extensionId: string | undefined;
    const registry = this.registry;
    const typeId = typeOfWidget(widget.id);
    const fail = (problem: string, request = false) => {
      if (!deliver) ended = true;
      if (!live) return;
      console.error(`[dashboard] ${escapeControls(`dashboard ${dashboardId}, widget ${widget.id} (${typeId}), ${role}: ${problem}`)}`);
      requestFailed = request && !ended;
      update(requestFailed ? { state: 'cannot-be-shown', retry: true } : { state: 'cannot-be-shown' });
    };
    const binding = this.bindingOf(widget, failure);
    update({ state: !failure && binding && formOf(binding) !== 'static' ? 'loading' : 'shown' });

    const run = async () => {
      if (!registry) return fail('the widgets domain was rejected at start');
      if (failure) return fail(`the widget fails its own registration: ${failure}`);
      let entry: string;
      let dataType: string | undefined;
      let renderType: string;
      try {
        const traits = effectiveTraits(this.types, typeId);
        entry = String(traits.entry);
        dataType = traits.data_type === undefined ? undefined : String(traits.data_type);
        if (dataType !== undefined && !this.types.getSchema(dataType)) throw new Error(`data_type ${dataType} is not registered`);
        renderType = renderTypeOf(this.types, typeId);
        if (!this.types.getSchema(renderType)) throw new Error(`render type ${renderType} is not registered`);
      } catch (error) {
        return fail(`traits: ${String(error)}`);
      }
      // The render is stamped and registered as its own instance, so it is validated against its exact render type,
      // as the data is against its data type; a failure fails this cell before anything mounts.
      // Reading and copying the render runs inside the try: a render from an in-code host may throw from a getter.
      let render: Record<string, unknown> | undefined;
      try {
        const named = RENDER_RESERVED_FIELDS.find((field) => Object.hasOwn(widget.render, field));
        if (named) return fail(`the render carries the GTS field ${named}`);
        render = { ...widget.render, id: renderStampIdOf(renderType, widget.id, role) };
        this.types.register(render);
      } catch (error) {
        const problem = String(error).split('\n').slice(0, 2).join(' ');
        return fail(render ? `the render fails ${renderType}: ${problem}` : `the render cannot be read: ${problem}`);
      }
      const id = extensionIdOf(widget.id, role, entry);
      // Extension ids do not depend on the dashboard: a widget named by two dashboards waits for every running release.
      await Promise.all(this.releasing.values());
      if (!live) return;
      extensionId = id;
      try {
        if (!registry.getExtension(id)) await registry.registerExtension({ id, domain: WIDGETS_DOMAIN_ID, entry });
        let ids = this.extensions.get(dashboardId);
        if (!ids) this.extensions.set(dashboardId, (ids = new Set()));
        ids.add(id);
      } catch (error) {
        return fail(`the generated extension is rejected: ${String(error)}`);
      }
      if (!live) return;
      const mounted = new Promise<void>((resolve, reject) => {
        // Each run waits on its own: a re-run of the same extension never takes over an earlier run's waiter.
        const waiters = this.mountWaiters.get(id) ?? new Set<(error?: unknown) => void>();
        this.mountWaiters.set(id, waiters);
        const timer = setTimeout(() => waiter(new Error(`mount_ext did not finish within ${MOUNT_TIMEOUT_MS} ms`)), MOUNT_TIMEOUT_MS);
        const waiter = (error?: unknown) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          if (error) reject(error instanceof Error ? error : new Error(String(error)));
          else resolve();
        };
        waiters.add(waiter);
      });
      registry.executeActionsChain({ action: { type: registry.typeSystem.resolveMountExtActionId(), target: WIDGETS_DOMAIN_ID, payload: { subject: id, history: 'none' } } });
      // The binding runs while the widget mounts; the root sends nothing before both have finished.
      latest = start(current);
      try {
        await mounted;
      } catch (error) {
        return fail(`mount_ext failed: ${String(error)}`);
      }
      if (!live) return;
      // A fallback unmounted the extension: the cell stays cannot-be-shown until the dashboard loads again, and a run
      // still in flight is dropped.
      const fellBack = (problem: string) => {
        ended = true;
        token += 1;
        fail(problem);
      };
      deliver = (data, run) => this.deliverCell({ id, widget, role, binding, dataType, render, registry, data, isCurrent: () => live && run === token, fail, fellBack, update });
      // A re-run during the mount replaced `latest`: the newest run delivers.
      await deliver(latest!.data, latest!.run);
    };
    let latest: { data: Promise<BindingResult>; run: number } | undefined;
    const start = (current: VariableValues) => {
      const run = ++token;
      requestFailed = false;
      awaited = undefined;
      const onShared = (answer: Promise<unknown>) => {
        if (run === token) awaited = answer;
      };
      const data = binding
        ? runBinding({ binding, host: this.host, shared, origin: this.origin, values: current, isLive: () => live && run === token, onShared })
        : Promise.resolve({ dropped: false as const, data: undefined });
      data.catch(() => undefined);
      return { data, run };
    };
    void run();

    return {
      leave: () => {
        live = false;
        if (!registry || !extensionId) return;
        this.renderFallbacks.delete(extensionId);
        this.leaving.add(extensionId);
        registry.executeActionsChain({ action: { type: registry.typeSystem.resolveUnmountExtActionId(), target: WIDGETS_DOMAIN_ID, payload: { subject: extensionId, history: 'none' } } });
      },
      rerun: (next) => {
        current = next;
        // A cell with no request, or one that failed before its extension was ready, has nothing to re-run; a cell
        // whose binding has not started yet starts it with `current`.
        if (!live || ended || !binding || formOf(binding) === 'static' || latest === undefined) return;
        latest = start(next);
        update({ state: 'loading' });
        if (deliver) void deliver(latest.data, latest.run);
      },
      ended: () => ended,
      requestFailed: () => requestFailed,
      waitsOn: (answer) => awaited === answer,
      source: binding && formOf(binding) === 'shared' ? (binding as { source: string }).source : undefined,
    };
  }

  /** Stamps a binding run's data and sends `render_widget`, unless a newer run or the cell's leave made the run stale. */
  private async deliverCell({
    id,
    widget,
    role,
    binding,
    dataType,
    render,
    registry,
    data,
    isCurrent,
    fail,
    fellBack,
    update,
  }: {
    id: string;
    widget: WidgetInstance;
    role: Role;
    binding: Binding | undefined;
    dataType: string | undefined;
    render: Record<string, unknown>;
    registry: MfeRegistry;
    data: Promise<BindingResult>;
    isCurrent: () => boolean;
    fail: (problem: string, request?: boolean) => void;
    fellBack: (problem: string) => void;
    update: (change: CellUpdate) => void;
  }): Promise<void> {
    let payload: Record<string, unknown> = { render };
    try {
      const result = await data;
      if (result.dropped || !isCurrent()) return;
      if (binding && dataType) {
        if (result.data === null || typeof result.data !== 'object' || Array.isArray(result.data)) throw new CellFailure(`the transform result is not an object`);
        // The stamp is the data's only identity: a result that names its own GTS id or schema would register under it unchecked.
        const named = GTS_IDENTITY_FIELDS.find((field) => Object.hasOwn(result.data as object, field));
        if (named) throw new CellFailure(`the transform result carries the GTS field ${named}`);
        const stamped = { ...(result.data as object), id: stampIdOf(dataType, widget.id, role) };
        try {
          this.types.register(stamped);
        } catch (error) {
          throw new CellFailure(`the data fails ${dataType}: ${String(error).split('\n').slice(0, 2).join(' ')}`);
        }
        payload = { ...payload, ...(widget.value_format ? { value_format: widget.value_format } : {}), data: stamped };
      }
    } catch (error) {
      if (!isCurrent()) return;
      return fail(error instanceof Error ? error.message : String(error), error instanceof RequestFailed);
    }
    if (!isCurrent()) return;
    // The widget draws at the size of its cell: the root sends `render_widget` once the cell holds the container.
    update({ state: 'placing' });
    const container = this.containers.get(id);
    if (container) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, PLACE_TIMEOUT_MS);
        update({ container, placed: () => (clearTimeout(timer), resolve()) });
      });
    }
    if (!isCurrent()) return;
    this.renderFallbacks.set(id, () => fellBack('the render_widget chain ended in fallback or timed out'));
    registry.executeActionsChain({
      action: { type: RENDER_WIDGET_ACTION_ID, target: id, payload },
      fallback: { action: { type: registry.typeSystem.resolveUnmountExtActionId(), target: WIDGETS_DOMAIN_ID, payload: { subject: id, history: 'none' } } },
    });
    // The widget resolves render_widget as soon as it holds the payload; a fallback turns the cell back to its placeholder.
    update({ state: 'shown' });
  }
}
