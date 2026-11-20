import { loadLifecycleStages } from '@gears-frontx/gts-plugin';
import type { TypeSystemPlugin } from '@gears-frontx/mfes';

import { DASHBOARD_TYPE_ID, WIDGET_BASE_TYPE_ID, type Dashboard, type ServedFile, type WidgetInstance } from '../contract';
import { BUNDLE_SCHEMAS, SHARED_PROPERTY_SCHEMAS, STAND_IN, STAND_IN_TYPE_ID } from '../gts';
import { uuidv5, type Role } from './ids';

/*
 * What the dashboard root registers, and in which order (DESIGN §3.6 step 4,
 * ADR-0003). Registering a type resolves none of its references (the store runs
 * with gts-ts `validateRefs` off, see ../gts/index.ts); they resolve,
 * transitively, when a type is compiled to validate something against it, as an
 * instance is on its registration. So the order decides where a dangling
 * reference fails:
 *
 * 1. the bundle: its schemas, and the theme and language property types where the store has none;
 * 2. the served file: its types, then its manifests and entries; a rejection fails every dashboard in the file;
 *    a file served in parts registers the base file so, then each widget part on its own, in order: a rejected
 *    part is left out with one console line, its dashboards are dropped, and the manifest and entry ids it failed
 *    to bring are recorded as rejected;
 * 3. each embedded widget instance on its own; a rejection, or an entry left out with its part, is the failure
 *    of that cell or larger view;
 * 4. a stand-in for each widget that failed in step 3, so the dashboard still names a registered widget there;
 * 5. the dashboard instance, which checks each embedded widget against the open widget base.
 */

const message = (error: unknown) => (error instanceof Error ? error.message.split('\n').slice(0, 2).join(' ') : String(error));

const idOf = (schema: Record<string, unknown>) => String(schema.$id ?? '').replace(/^gts:\/\//, '');

/** Step 1. Returns the ids of the bundle schemas, which a served type must not reuse. */
export function registerBundle(types: TypeSystemPlugin): Set<string> {
  for (const schema of BUNDLE_SCHEMAS) types.registerSchema(schema);
  for (const schema of SHARED_PROPERTY_SCHEMAS) if (!types.getSchema(idOf(schema))) types.registerSchema(schema);
  types.registerSchema(STAND_IN.schema);
  for (const instance of STAND_IN.instances) types.register(instance);
  return new Set([...BUNDLE_SCHEMAS.map(idOf), STAND_IN_TYPE_ID]);
}

/**
 * `rejected` maps each manifest and entry id that a left-out widget part failed to bring to the reason: the cells whose
 * widget type names one of those entries fail with it. An id the base file or a registered part already brought is
 * never in it.
 */
export type FileOutcome = { ok: true; dashboards: Map<string, Dashboard>; rejected: ReadonlyMap<string, string> } | { ok: false; problem: string };

const MANIFEST_TYPE_PREFIX = 'gts.frontx.mfes.mfe.mf_manifest.v1~';

const isObject = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);

/** JSON text with object keys sorted, so two definitions compare by content. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) => (isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));

/** What the served file brought so far: the base file and every widget part that registered whole. */
interface Held {
  /** Each manifest and entry id with its canonical content. */
  instances: Map<string, string>;
  dashboards: Map<string, Dashboard>;
}

const idOfInstance = (instance: Record<string, unknown>) => String(instance.id ?? '');

/**
 * The reason a served file or part cannot register, or nothing. A widget part is checked whole against what is held
 * before anything of it registers; past that check, the store keeps what the part registered before a failing item.
 * Only a part that registers whole adds its manifests, entries and dashboards to `held`.
 */
function registerPart(types: TypeSystemPlugin, part: unknown, bundleIds: ReadonlySet<string>, held: Held, isBase: boolean): string | undefined {
  const served = part as Partial<ServedFile> | null;
  if (!isObject(served) || !Array.isArray(served.types) || !Array.isArray(served.instances)) return 'it has no types and instances lists';
  if (!served.types.every(isObject) || !served.instances.every(isObject)) return 'it has an entry that is not an object';
  const clash = served.types.map(idOf).find((id) => bundleIds.has(id));
  if (clash) return `its type ${clash} equals a bundle base`;
  const dashboards = served.instances.filter((instance) => idOfInstance(instance).startsWith(DASHBOARD_TYPE_ID));
  const instances = served.instances.filter((instance) => !idOfInstance(instance).startsWith(DASHBOARD_TYPE_ID));
  // Two records under one id in the same part would both register, the last write winning; alike ones are fine. Only a
  // repeated id is compared, so a record that cannot be read fails where it did before, not the whole part.
  const seen = new Map<string, Record<string, unknown>>();
  for (const instance of served.instances) {
    const id = idOfInstance(instance);
    if (!id) continue;
    const was = seen.get(id);
    if (was !== undefined && canonical(was) !== canonical(instance)) return `its ${id.startsWith(DASHBOARD_TYPE_ID) ? 'dashboard' : 'instance'} ${id} comes twice, the second otherwise`;
    seen.set(id, instance);
  }
  if (!isBase) {
    // The store keeps the first definition of a type and ignores a different one; a part that brings one is left out.
    for (const schema of served.types) {
      const was = types.getSchema(idOf(schema));
      if (was && canonical(was) !== canonical(schema)) return `its type ${idOf(schema)} is already defined otherwise`;
    }
    // The store keeps the last write of an instance; a part may not replace what the base file or a registered part brought.
    for (const instance of instances) {
      const was = held.instances.get(idOfInstance(instance));
      if (was !== undefined && was !== canonical(instance)) return `its instance ${idOfInstance(instance)} is already registered otherwise`;
    }
    // A dashboard id already served is the part's only with the same content, as for manifests and entries.
    const taken = dashboards.find((dashboard) => {
      const was = held.dashboards.get(idOfInstance(dashboard));
      return was !== undefined && canonical(was) !== canonical(dashboard);
    });
    if (taken) return `its dashboard ${idOfInstance(taken)} is already served otherwise`;
  }
  try {
    for (const schema of served.types) types.registerSchema(schema);
    for (const instance of instances) types.register(instance);
  } catch (error) {
    return `the registry rejected it: ${message(error)}`;
  }
  for (const instance of instances) held.instances.set(idOfInstance(instance), canonical(instance));
  for (const dashboard of dashboards) held.dashboards.set(idOfInstance(dashboard), dashboard as unknown as Dashboard);
  return undefined;
}

/**
 * A part's reason, with a throw turned into one: an in-code host can answer content JSON never carries (a BigInt, a
 * cycle, a getter that throws), which the content checks cannot read. Such a part is left out like any rejected one.
 */
function guarded(check: () => string | undefined): string | undefined {
  try {
    return check();
  } catch (error) {
    return `it cannot be read: ${message(error)}`;
  }
}

/** The longest part name a console line carries. */
const NAME_CAP = 200;

/** Every control character (C0, DEL, C1 with U+0085) and the line and paragraph separators U+2028 and U+2029 as `\uXXXX`. */
export const escapeControls = (text: string) =>
  text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A part name as it stands in one console line: JSON-quoted, with the characters JSON keeps as they are escaped too. */
const quoted = (name: string) => escapeControls(JSON.stringify(name));

/**
 * Step 2: the served file, or a dashboard-level failure. A host answers one
 * joined file, or the file in parts: the base file (the catalog types and the
 * dashboards), then one part per widget bundle. A rejected base file fails
 * every dashboard; a rejected widget part is left out with one console line,
 * its dashboards never load, and only the cells whose widget type names an
 * entry the part failed to bring fail.
 */
export function registerServedFile(types: TypeSystemPlugin, file: unknown, bundleIds: ReadonlySet<string>): FileOutcome {
  const [base, ...parts] = Array.isArray(file) ? file : [file];
  // The stand-in records and the plugin's lifecycle stages, in the store before the file, count as held, so no part replaces them.
  const before = [...STAND_IN.instances, ...(loadLifecycleStages() as unknown as Record<string, unknown>[])];
  const held: Held = { instances: new Map(before.map((instance) => [idOfInstance(instance), canonical(instance)])), dashboards: new Map() };
  const problem = guarded(() => registerPart(types, base, bundleIds, held, true));
  if (problem) return { ok: false, problem: `the served file: ${problem}` };
  const rejected = new Map<string, string>();
  parts.forEach((part, index) => {
    let ids: string[] = [];
    const reason = guarded(() => {
      const instances = isObject(part) && Array.isArray(part.instances) ? part.instances.filter(isObject) : [];
      ids = instances.map(idOfInstance).filter((id) => id && !id.startsWith(DASHBOARD_TYPE_ID));
      return registerPart(types, part, bundleIds, held, false);
    });
    if (!reason) {
      // A healthy part's own registration replaces what an earlier rejected part left under the same id.
      for (const id of ids) rejected.delete(id);
      return;
    }
    const listed = ids.filter((id) => id.startsWith(MANIFEST_TYPE_PREFIX)).join(', ');
    // Quoted, escaped and capped: the ids come from the part, and a line break in one would fake another console line.
    const name = listed ? quoted(listed.length > NAME_CAP ? `${listed.slice(0, NAME_CAP)}...` : listed) : `number ${index + 2} of the answer (the served file is number 1)`;
    // The reason quotes ids from the part as well (a registry message, an id held otherwise), so it is escaped the same way.
    const line = `the widget part ${name} is left out: ${escapeControls(reason)}`;
    console.error(`[dashboard] ${line}`);
    // A rejected part held nothing, so `held` still names what registered before it: those ids stay healthy.
    for (const id of ids) if (!held.instances.has(id)) rejected.set(id, line);
  });
  return { ok: true, dashboards: held.dashboards, rejected };
}

/** The reason the entry of a widget's type was left out with its part, or nothing. */
function leftOut(types: TypeSystemPlugin, widgetId: string, rejected: ReadonlyMap<string, string>): string | undefined {
  if (rejected.size === 0) return undefined;
  try {
    return rejected.get(String(effectiveTraits(types, typeOfWidget(widgetId)).entry));
  } catch {
    // A type that does not resolve fails the widget's own registration below.
    return undefined;
  }
}

/** Where a failure of an embedded widget instance shows: its cell, as the widget or as the larger view. */
export const slotOf = (cell: number, role: Role) => `${cell}:${role}`;

/** `dashboard` is the dashboard as the cells run it: each widget and larger view is the copy read on load. */
export type DashboardOutcome =
  | { ok: true; dashboard: Dashboard; failed: ReadonlyMap<string, string> }
  | { ok: false; problem: string };

const SLOTS = [['widget', 'cell'], ['larger_view', 'larger_view']] as const;

/** The stand-in id of a slot: from the widget id, or from the cell's place when the id cannot be read. */
const standInIdOf = (widgetId: string, role: Role) => `${STAND_IN_TYPE_ID}${uuidv5(`${widgetId.toLowerCase()}|${role}`)}`;

/**
 * Steps 3 to 5 for one dashboard. `failed` maps a slot to the reason its widget instance failed its own registration,
 * or the reason its widget part was left out (`rejected` of the file outcome).
 *
 * Each widget and larger view is read once, as a JSON copy, before anything registers: a widget from an in-code host
 * may throw from a getter, and every later step (registration, stand-in, the dashboard's registration, the cell run)
 * reads only the copy. A widget that cannot be read fails its slot, which gets a minimal stand-in.
 */
export function registerDashboard(types: TypeSystemPlugin, dashboard: Dashboard, rejected: ReadonlyMap<string, string> = new Map()): DashboardOutcome {
  const failed = new Map<string, string>();
  // A slot fails once: a slot that failed its read is never registered again, so no second reason comes.
  const fail = (slot: string, reason: string) => failed.set(slot, reason);
  const wellFormed = Array.isArray(dashboard.layout?.cells);
  const read = (wellFormed ? dashboard.layout.cells : []).map((cell, index) => {
    if (!cell || typeof cell !== 'object') return cell;
    // The cell's other fields, one by one: a field whose getter throws is left out, and the dashboard's type check judges the cell.
    const fields = cell as unknown as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    try {
      for (const key of Object.keys(fields)) {
        if (key === 'widget' || key === 'larger_view') continue;
        try {
          copy[key] = fields[key];
        } catch {
          // Left out.
        }
      }
    } catch {
      // A cell whose keys cannot be listed keeps no other field.
    }
    for (const [key, role] of SLOTS) {
      // Each slot is read once, inside the guard: a getter on the cell's own property fails this slot only.
      let widget: unknown;
      try {
        widget = fields[key];
        if (widget === undefined) continue;
        copy[key] = JSON.parse(JSON.stringify(widget)) as WidgetInstance;
      } catch (error) {
        fail(slotOf(index, role), `the widget cannot be read: ${message(error)}`);
        let id: unknown;
        try {
          id = (widget as { id?: unknown } | null | undefined)?.id;
        } catch {
          // An id that cannot be read either: the stand-in takes its id from the cell's place.
        }
        copy[key] = { id: standInIdOf(typeof id === 'string' ? id : `cell ${index}`, role), render: {} } as WidgetInstance;
      }
    }
    return copy as unknown as typeof cell;
  });
  const validated = read.map((cell, index) => {
    if (!cell || typeof cell !== 'object') return cell;
    const copy = { ...cell };
    for (const [key, role] of SLOTS) {
      const widget = cell[key] as WidgetInstance | undefined;
      // A widget with no string id breaks the open widget base: the dashboard's own validation reports it.
      if (!widget || typeof widget.id !== 'string') continue;
      // A widget that cannot be read is its minimal stand-in already.
      if (failed.has(slotOf(index, role))) {
        try {
          types.register(widget);
        } catch {
          // Left in place: the dashboard registration below fails at this widget, at dashboard level.
        }
        continue;
      }
      try {
        const part = leftOut(types, widget.id, rejected);
        if (part) throw new Error(part);
        types.register(widget);
      } catch (error) {
        fail(slotOf(index, role), message(error));
        // The stand-in keeps every field of the widget, so a widget that also breaks the open base still fails the dashboard.
        // The one exception is a render id: only the root stamps it, so a dashboard's own one, which may name no
        // registered render, stays a failure of this cell.
        try {
          const standIn = { ...widget, id: standInIdOf(widget.id, role), render: withoutRenderId(widget.render) };
          types.register(standIn);
          copy[key] = standIn;
        } catch {
          // Left in place: the dashboard registration below fails at this widget, at dashboard level.
        }
      }
    }
    return copy;
  });
  // After validation: a widget that fails its own type already has its stand-in and keeps that reason; a valid widget
  // in a frameless cell that breaks the rule stays as it is and fails its cell.
  read.forEach((cell, index) => {
    const problem = framelessProblem(cell);
    if (!problem) return;
    // Both slots fail with the same reason: the cell shows cannot-be-shown, and its larger view runs nothing.
    for (const [key, role] of SLOTS) if (cell[key] !== undefined && !failed.has(slotOf(index, role))) fail(slotOf(index, role), problem);
  });
  const copied = wellFormed ? { ...dashboard, layout: { ...dashboard.layout, cells: read } } : dashboard;
  try {
    // Only a well-formed cells list gets its copies and stand-ins; anything else registers as delivered, so the type rejects it.
    types.register(wellFormed ? { ...dashboard, layout: { ...dashboard.layout, cells: validated } } : dashboard);
  } catch (error) {
    return { ok: false, problem: `the dashboard fails its type: ${message(error)}` };
  }
  return { ok: true, dashboard: copied as Dashboard, failed };
}

/**
 * The reason a frameless cell (`frame: false`) fails, or nothing. It draws no header, so a widget title, a widget
 * description or a larger view there would be dropped without a word; it is drawn full width between the grid groups
 * at the height of its content, so any size but `large` and any height would be dropped the same way. Any other
 * `frame` value is left to the type.
 */
function framelessProblem(cell: unknown): string | undefined {
  if (!isObject(cell) || cell.frame !== false) return undefined;
  const widget = isObject(cell.widget) ? cell.widget : {};
  const named = [
    widget.title !== undefined && 'a widget title',
    widget.description !== undefined && 'a widget description',
    cell.larger_view !== undefined && 'a larger_view',
    cell.size !== 'large' && `the size ${String(cell.size)}`,
    cell.height !== undefined && `the height ${String(cell.height)}`,
  ].filter(Boolean);
  return named.length > 0
    ? `the cell has frame false, which draws no header and spans the full width at the height of its content, and carries ${named.join(', ')}`
    : undefined;
}

/**
 * The effective traits of a widget type (widget contract FEATURE, "Resolve
 * effective traits"): the trait values merged root to leaf along the type
 * chain, with the trait schema's defaults filled.
 */
export function effectiveTraits(types: TypeSystemPlugin, typeId: string): Record<string, unknown> {
  const segments = typeId.split('~').filter(Boolean);
  const traits: Record<string, unknown> = {};
  const defaults: Record<string, unknown> = {};
  const required = new Set<string>();
  for (let i = 1; i <= segments.length; i++) {
    const id = `${segments.slice(0, i).join('~')}~`;
    const schema = types.getSchema(id) as Record<string, unknown> | undefined;
    if (!schema) throw new Error(`type ${id} is not registered`);
    const traitSchema = schema['x-gts-traits-schema'] as { properties?: Record<string, { default?: unknown }>; required?: string[] } | undefined;
    for (const [name, property] of Object.entries(traitSchema?.properties ?? {})) if (property.default !== undefined) defaults[name] = property.default;
    for (const name of traitSchema?.required ?? []) required.add(name);
    Object.assign(traits, schema['x-gts-traits'] as Record<string, unknown> | undefined);
  }
  const effective = { ...defaults, ...traits };
  for (const name of required) if (effective[name] === undefined) throw new Error(`trait ${name} of ${typeId} is not set`);
  return effective;
}

/** The render base: the render type of a widget type whose `render` names no render type by `$ref`. */
const RENDER_BASE_TYPE_ID = 'gts.frontx.dashboard.widget.render.v1~';

/**
 * The render type of a widget type: the `$ref` of the `render` property declared nearest along the type chain, read
 * from the type's own schema at the top level (`properties.render`) and in its direct `allOf` members. The one `$ref`
 * among them decides, an inline declaration beside it adds only narrowing; two different `$ref`s throw. A `render`
 * declared only inline, with no `$ref`, gives the render base. A `$ref` to a type that is neither the render base nor derived from
 * it (its id does not start with the render base id) is no render type: it throws, naming both ids, and fails the
 * widget's cells.
 */
export function renderTypeOf(types: TypeSystemPlugin, typeId: string): string {
  const segments = typeId.split('~').filter(Boolean);
  for (let i = segments.length; i >= 1; i--) {
    const id = `${segments.slice(0, i).join('~')}~`;
    const schema = types.getSchema(id) as { properties?: { render?: unknown }; allOf?: unknown } | undefined;
    if (!schema) throw new Error(`type ${id} is not registered`);
    const parts = [schema, ...(Array.isArray(schema.allOf) ? (schema.allOf as typeof schema[]) : [])];
    const declared = parts.map((part) => part?.properties?.render as { $ref?: unknown } | undefined).filter((render) => render !== undefined);
    if (declared.length === 0) continue;
    // Every render declaration of this type counts, in any order: an inline one beside a `$ref` does not hide it.
    const refs = [...new Set(declared.flatMap((render) => (typeof render?.$ref === 'string' ? [render.$ref.replace(/^gts:\/\//, '')] : [])))];
    if (refs.length > 1) throw new Error(`the render of ${id} names more than one render type: ${refs.join(', ')}`);
    if (refs.length === 0) return RENDER_BASE_TYPE_ID;
    const named = refs[0];
    if (!named.startsWith(RENDER_BASE_TYPE_ID)) throw new Error(`the render of ${id} names ${named}, which is not the render base ${RENDER_BASE_TYPE_ID} or a type derived from it`);
    return named;
  }
  return RENDER_BASE_TYPE_ID;
}

/** A render object without its `id`; anything else as given, for the type to judge. */
const withoutRenderId = <T,>(render: T): T => {
  if (!render || typeof render !== 'object' || Array.isArray(render) || !Object.hasOwn(render, 'id')) return render;
  const { id: _stamp, ...rest } = render as Record<string, unknown>;
  return rest as T;
};

/** The widget type of an embedded widget instance: its id without the trailing instance segment. */
export const typeOfWidget = (widgetId: string) => widgetId.slice(0, widgetId.lastIndexOf('~') + 1);

export const isWidgetId = (id: unknown): id is string => typeof id === 'string' && id.startsWith(WIDGET_BASE_TYPE_ID);
