import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';

import { intlLocaleOf, kitScopeOf, type DashboardCell, type WidgetInstance } from '../contract';
import { DashboardArea, DEFAULT_DASHBOARD_TEXTS, type DashboardTexts } from '../DashboardArea';
import { CellFrame, DEFAULT_FRAME_TEXTS, StateBody, useRetryFocus, type CellState, type FrameTexts } from '../frame/CellFrame';
import { readValue, SharedRequests, UNREADABLE, variablesOfBinding, type VariableValues } from './binding';
import type { CellRun, DashboardRoot, LoadOutcome } from './DashboardRoot';
import type { Role } from './ids';
import { escapeControls, slotOf } from './register';

/*
 * The dashboard as a React component: the single-page hosting form of the
 * dashboard root (DESIGN §3.3 Host interface). The host passes the root, a
 * dashboard id, its theme id and language; the widgets inside stay FrontX
 * MFEs, each mounted by the root's registry in its own shadow root.
 */

/** The quiet time after the last size change of a cell before its widget draws. */
const SETTLE_MS = 80;
const HIDDEN: CSSProperties = { display: 'none' };
const SLOT: CSSProperties = { display: 'flex', flex: 1, flexDirection: 'column', minBlockSize: 0 };
const PLACING_FRAME: CSSProperties = { ...SLOT, position: 'relative' };
const PLACING_LOADER: CSSProperties = { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' };

export interface DashboardProps {
  root: DashboardRoot;
  dashboardId: string;
  /** The host theme id, published unchanged to the widgets. */
  theme: string;
  /** The host language, published unchanged to the widgets. */
  language: string;
  texts?: { dashboard?: DashboardTexts; frame?: FrameTexts };
  /**
   * The variable values the requests take, by variable name, owned by the host (for example its own period control
   * or the product's URL). A request that names a variable missing here, or whose value is not a string, a finite
   * number or a boolean, fails its cell. A change of a value re-runs only the cells whose request names it.
   */
  variables?: VariableValues;
}

export function Dashboard({ root, dashboardId, theme, language, texts, variables }: DashboardProps) {
  // Both values are on the domain before any cell mounts: a layout effect runs before the cells' own effects.
  useLayoutEffect(() => root.publish(theme, language), [root, theme, language]);
  const [outcome, setOutcome] = useState<{ id: string; outcome: LoadOutcome }>();
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const previous = useRef<string | undefined>(undefined);

  useEffect(() => {
    let current = true;
    let settled = false;
    const load = root.load(dashboardId);
    void load.then(() => (settled = true), () => (settled = true));
    void load
      .catch((error: unknown): LoadOutcome => {
        // The first two lines of the error, escaped like the root's own lines: a stack or an id must not fake another line.
        console.error(`[dashboard] ${escapeControls(`dashboard ${dashboardId} cannot be shown: ${String(error).split('\n').slice(0, 2).join(' ')}`)}`);
        return { ok: false };
      })
      .then((result) => current && setOutcome({ id: dashboardId, outcome: result }));
    // A new dashboard id unregisters the generated extensions of the one before; leaving keeps them for a return.
    if (previous.current !== undefined && previous.current !== dashboardId) void root.release(previous.current);
    previous.current = dashboardId;
    return () => {
      current = false;
      // Unmounting while loading discards the load: the next mount starts a new one.
      if (!settled) root.forget(dashboardId, load);
    };
  }, [root, dashboardId]);

  const loaded = outcome?.id === dashboardId ? outcome.outcome : undefined;
  const frameTexts = texts?.frame ?? DEFAULT_FRAME_TEXTS;
  return (
    <div data-theme={kitScopeOf(theme)} lang={intlLocaleOf(language)} ref={setContainer} style={{ display: 'contents' }}>
      <div ref={(element) => root.attach(element)} style={HIDDEN} />
      {loaded?.ok ? (
        <LoadedDashboard
          key={dashboardId}
          root={root}
          dashboardId={dashboardId}
          loaded={loaded}
          texts={texts?.dashboard}
          frameTexts={frameTexts}
          container={container}
          values={variables}
        />
      ) : (
        <DashboardArea failed={loaded !== undefined} renderCell={() => null} texts={texts?.dashboard ?? DEFAULT_DASHBOARD_TEXTS} />
      )}
    </div>
  );
}

function LoadedDashboard({
  root,
  dashboardId,
  loaded,
  texts,
  frameTexts,
  container,
  values: given,
}: {
  root: DashboardRoot;
  dashboardId: string;
  loaded: Extract<LoadOutcome, { ok: true }>;
  texts?: DashboardTexts;
  frameTexts: FrameTexts;
  container: HTMLElement | null;
  values?: VariableValues;
}) {
  // One set of held shared answers per shown dashboard; it goes with the dashboard.
  const shared = useMemo(() => new SharedRequests(loaded.dashboard.requests ?? {}, root.host, root.origin), [loaded, root]);
  const plain = given !== null && typeof given === 'object' ? given : NO_VALUES;
  const names = namesOf(plain);
  // Values whose names cannot be listed are unreadable as a whole, and every such object is the same unreadable
  // values: the cells that name a variable fail, and the next readable values run them again.
  const values = names === undefined ? UNREADABLE_VALUES : plain;
  // The host may pass a new object with the same values on every render: the key stands for the values themselves.
  const valuesKey = names === undefined ? 'unreadable' : keyOfValues(values, names);
  // `valuesKey` stands for `values`.
  const current = useMemo(() => values, [valuesKey]);
  // The running cells and larger views by slot; a closed larger view has none.
  const runs = useRef(new Map<string, CellRun>()).current;
  // Every shared request a live cell or a larger view names is sent once per built request, as soon as the values are
  // known, not on the first widget that asks. At load that covers every cell and larger view, open or closed; on a
  // variable change only the slots with a live run (an open cell or an open larger view), so a closed larger view asks
  // for the new values when it opens. A slot that failed its registration, or whose run has ended (a fallback), sends
  // nothing. The cells' own effects run first, so a run ended before this commit is skipped.
  // The held answers last prefetched for: a new `loaded` or `root` builds new ones without a remount, and that is a load again.
  const prefetched = useRef<SharedRequests | null>(null);
  useEffect(() => {
    const atLoad = prefetched.current !== shared;
    prefetched.current = shared;
    loaded.dashboard.layout.cells.forEach((cell, index) => {
      for (const [widget, role] of [[cell.widget, 'cell'], [cell.larger_view, 'larger_view']] as const) {
        const slot = slotOf(index, role);
        const run = runs.get(slot);
        if (!widget || loaded.failed.has(slot) || run?.ended() || (!atLoad && !run)) continue;
        const source = (root.bindingOf(widget, undefined) as { source?: unknown } | undefined)?.source;
        if (typeof source === 'string' && shared.has(source)) void shared.get(source, current).catch(() => undefined);
      }
    });
    // `valuesKey` stands for `current`.
  }, [loaded, root, runs, shared, valuesKey]);
  // A retry runs the failed cell's binding again the way a variable change does, with the current values. For a shared
  // request it first drops the held failed answer, then re-runs every live run on that same shared request whose
  // request failed or that still waits on the dropped answer (a cell still mounting has not reported it yet), so the
  // request goes out once for all of them and each shows the new answer. A run with a good answer is left alone.
  const retry = (slotId: string) => {
    const run = runs.get(slotId);
    if (!run?.requestFailed()) return;
    const { source } = run;
    const dropped = source === undefined ? undefined : shared.forgetFailure(source, current);
    const affected = (other: CellRun) => other.source === source && (other.requestFailed() || (dropped !== undefined && other.waitsOn(dropped)));
    for (const other of [...runs.values()]) if (other === run || (source !== undefined && affected(other))) other.rerun(current);
  };
  return (
    <DashboardArea
      layout={loaded.dashboard.layout}
      texts={texts ?? DEFAULT_DASHBOARD_TEXTS}
      renderCell={(cell, index) => (
        <Cell root={root} dashboardId={dashboardId} cell={cell} index={index} failed={loaded.failed} shared={shared} values={current} texts={frameTexts} container={container} runs={runs} retry={retry} />
      )}
    />
  );
}

const NO_VALUES: VariableValues = {};

/**
 * The names the host's values carry, enumerable or not, or nothing when listing them throws (a Proxy). The listing
 * reads no property, so a value whose read throws fails only the cells whose request names it.
 */
const namesOf = (values: VariableValues) => {
  try {
    return Object.getOwnPropertyNames(values);
  } catch {
    return undefined;
  }
};

const unreadable = () => {
  throw new Error('unreadable');
};
/** Values every read of which throws: each variable a request names then fails its cells as one that cannot be read. */
const UNREADABLE_VALUES: VariableValues = new Proxy({}, { get: unreadable, has: unreadable, ownKeys: unreadable, getOwnPropertyDescriptor: unreadable });

/**
 * A key for the values of these names that tells every given value apart, by its type and text: a missing name, a
 * string "1" and a number 1, and a NaN all give different keys; any object or function gives one key per kind, as none
 * is a valid value, and so does a value that cannot be read, which fails only the cells whose request names it.
 */
const keyOfValues = (values: VariableValues, names: readonly string[]) =>
  JSON.stringify(
    [...names].sort().map((name) => {
      const read = readValue(values, name);
      if (read === UNREADABLE) return [name, 'unreadable'];
      if (!read) return [name];
      const { value } = read;
      // An object or a function is never a valid value: its kind is enough, and reading its text could throw.
      if (typeof value === 'function' || (value !== null && typeof value === 'object')) return [name, typeof value];
      // Only primitives and null reach here, and their text never runs host code.
      return [name, typeof value, String(value)];
    }),
  );

/** Runs a widget through the root and gives back its state and the element that holds its container. */
function useWidget(
  root: DashboardRoot,
  dashboardId: string,
  widget: WidgetInstance,
  role: Role,
  failure: string | undefined,
  shared: SharedRequests,
  values: VariableValues,
  runs: Map<string, CellRun>,
  slotId: string,
) {
  const [state, setState] = useState<CellState | 'placing'>('loading');
  // True while the cannot-be-shown state came from a failed data request: the frame then offers a retry.
  const [retryable, setRetryable] = useState(false);
  const [placement, setPlacement] = useState<{ container: HTMLElement; placed: () => void }>();
  const slot = useRef<HTMLDivElement>(null);
  const run = useRef<CellRun>(undefined);
  const latest = useRef(values);
  latest.current = values;
  useEffect(() => {
    const cell = root.runCell({
      dashboardId,
      widget,
      role,
      failure,
      shared,
      values: latest.current,
      update: (change) => {
        if (!('state' in change)) return setPlacement(change);
        setState(change.state);
        setRetryable(change.retry === true);
      },
    });
    run.current = cell;
    runs.set(slotId, cell);
    return () => {
      run.current = undefined;
      if (runs.get(slotId) === cell) runs.delete(slotId);
      cell.leave();
    };
  }, [root, dashboardId, widget, role, failure, shared, runs, slotId]);
  // Only a change of a variable this widget's request names re-runs it: the values of those variables are its key.
  const binding = useMemo(() => root.bindingOf(widget, failure), [root, widget, failure]);
  const dependsOn = binding ? variablesOfBinding(binding, shared) : [];
  const dependencyKey = keyOfValues(values, dependsOn);
  // The key the cell last ran with: StrictMode runs this effect twice on mount, and the second run, with the same key,
  // must not re-run the cell. The root's own `latest` check covers a re-run the first show has not started yet.
  const ranWith = useRef(dependencyKey);
  useEffect(() => {
    if (ranWith.current === dependencyKey) return;
    ranWith.current = dependencyKey;
    run.current?.rerun(latest.current);
  }, [dependencyKey]);
  // The domain mounts the container under its own hidden root; the cell takes it once it shows.
  useEffect(() => {
    const target = slot.current;
    if ((state !== 'shown' && state !== 'placing') || !placement || !target) return undefined;
    if (placement.container.parentElement !== target) target.appendChild(placement.container);
    // The kit Grid settles the cell's span after its first layout; the widget draws once the slot keeps its size.
    let timer = setTimeout(placement.placed, SETTLE_MS);
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(placement.placed, SETTLE_MS);
    });
    observer.observe(target);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [state, placement]);
  return { state, slot, retryable };
}

function Cell({
  root,
  dashboardId,
  cell,
  index,
  failed,
  shared,
  values,
  texts,
  container,
  runs,
  retry,
}: {
  root: DashboardRoot;
  dashboardId: string;
  cell: DashboardCell;
  index: number;
  failed: ReadonlyMap<string, string>;
  shared: SharedRequests;
  values: VariableValues;
  texts: FrameTexts;
  container: HTMLElement | null;
  runs: Map<string, CellRun>;
  retry: (slotId: string) => void;
}) {
  const { state, slot, retryable } = useWidget(root, dashboardId, cell.widget, 'cell', failed.get(slotOf(index, 'cell')), shared, values, runs, slotOf(index, 'cell'));
  const [open, setOpen] = useState(false);
  // A frameless cell has no button to open a larger view; one that names a larger view failed its registration.
  const frame = cell.frame !== false;
  const larger = frame ? cell.larger_view : undefined;
  const largerTitle = larger?.title ?? cell.widget.title ?? '';
  return (
    <CellFrame
      frame={frame}
      title={cell.widget.title}
      description={cell.widget.description}
      state={state === 'placing' ? 'shown' : state}
      texts={texts}
      onRetry={retryable ? () => retry(slotOf(index, 'cell')) : undefined}
      largerView={
        larger
          ? {
              title: largerTitle,
              description: larger.description,
              // The larger view draws its own states inside the overlay.
              state: 'shown',
              content: open ? (
                <LargerView
                  root={root}
                  dashboardId={dashboardId}
                  widget={larger}
                  title={largerTitle}
                  failure={failed.get(slotOf(index, 'larger_view'))}
                  shared={shared}
                  values={values}
                  texts={texts}
                  runs={runs}
                  slotId={slotOf(index, 'larger_view')}
                  retry={retry}
                />
              ) : null,
              onOpenChange: setOpen,
              container,
            }
          : undefined
      }
    >
      <WidgetSlot state={state} slot={slot} texts={texts} />
    </CellFrame>
  );
}

function LargerView({
  root,
  dashboardId,
  widget,
  title,
  failure,
  shared,
  values,
  texts,
  runs,
  slotId,
  retry,
}: {
  root: DashboardRoot;
  dashboardId: string;
  widget: WidgetInstance;
  /** The overlay's title, for the retry button's name. */
  title: string;
  failure?: string;
  shared: SharedRequests;
  values: VariableValues;
  texts: FrameTexts;
  runs: Map<string, CellRun>;
  slotId: string;
  retry: (slotId: string) => void;
}) {
  const { state, slot, retryable } = useWidget(root, dashboardId, widget, 'larger_view', failure, shared, values, runs, slotId);
  const shown = state === 'placing' ? 'shown' : state;
  // Inside the dialog too, a retry keeps focus in place: on this wrapper while it loads, then on the new button or here.
  const focus = useRetryFocus(shown, retryable ? () => retry(slotId) : undefined);
  return (
    <div ref={focus.wrapper} tabIndex={-1} style={SLOT}>
      <StateBody state={shown} texts={texts} onRetry={focus.retry} title={title} retryRef={focus.button}>
        <WidgetSlot state={state} slot={slot} texts={texts} />
      </StateBody>
    </div>
  );
}

/**
 * The element the widget's container goes into. While the root places it (`placing`), the slot already has its
 * full size so the widget draws at the cell's size, but stays hidden under the cell's loader until render_widget
 * has gone out.
 */
function WidgetSlot({ state, slot, texts }: { state: CellState | 'placing'; slot: RefObject<HTMLDivElement | null>; texts: FrameTexts }) {
  const placing = state === 'placing';
  return (
    <div style={PLACING_FRAME}>
      <div ref={slot} style={placing ? { ...SLOT, visibility: 'hidden' } : SLOT} />
      {placing ? (
        <div style={PLACING_LOADER}>
          <StateBody state="loading" texts={texts} />
        </div>
      ) : null}
    </div>
  );
}

