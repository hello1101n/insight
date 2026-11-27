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
 *    to bring, with the type ids it declared and did not register, are recorded as rejected;
 * 3. each embedded widget instance on its own; a rejection, or the widget's type or entry left out with its part,
 *    is the failure of that cell or larger view;
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
 * What the left-out widget parts failed to bring, with the reason each id is left out under, in two maps so the two
 * kinds of id stay apart: `instances` maps each manifest and entry id a part failed to bring, `types` each type id
 * a part declared that did not register. `leftOut` reads the instance map for the widget's entry and the type map
 * for its widget, render and data type, so an id of the one kind that equals an id of the other cannot fail a cell
 * of the other kind. The cells whose widget type names one of the rejected entries, or whose type is one of the
 * rejected type ids, fail with it, and so do the cells of a type that extends, by `$ref` or by a chained id's `~`
 * prefix, a type id the store still lacks because a left-out part declared it: the walk through the `$ref` chain
 * and the prefixes names the part that left the ancestor out. An id the base file or a registered part already
 * brought is never in either map.
 */
export type Rejected = { readonly instances: ReadonlyMap<string, string>; readonly types: ReadonlyMap<string, string> };

export type FileOutcome = { ok: true; dashboards: Map<string, Dashboard>; rejected: Rejected } | { ok: false; problem: string };

const MANIFEST_TYPE_PREFIX = 'gts.frontx.mfes.mfe.mf_manifest.v1~';

const isObject = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);

/** JSON text with object keys sorted, so two definitions compare by content. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) => (isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));

/**
 * The ids of the shared-property types the root registers itself before the served file (the same constant
 * registerBundle registers from): the store holds a definition of each from before the file, so no file that
 * carries a copy of one is a source of the type.
 */
const ROOT_TYPE_IDS: ReadonlySet<string> = new Set(SHARED_PROPERTY_SCHEMAS.map(idOf));

/**
 * What the served file brought so far: the base file and every widget part that registered whole, with the source
 * each registered type id came from first.
 */
interface Held {
  /** Each manifest and entry id with its canonical content. */
  instances: Map<string, string>;
  dashboards: Map<string, Dashboard>;
  /** Each type id in the store with the phrase naming the source that registered it first: the served file or the widget part. */
  sources: Map<string, string>;
}

const idOfInstance = (instance: Record<string, unknown>) => String(instance.id ?? '');

/**
 * The reason a served file or part cannot register, or nothing. A widget part is checked whole against what is held
 * before anything of it registers; past that check, the store keeps what the part registered before a failing item.
 * Only a part that registers whole adds its manifests, entries and dashboards to `held`. Every type id the served
 * file or part registers is recorded in `held.sources` under `source` when the store holds the definition it
 * registered, its first source, except a type the root registers itself: the store keeps those types when the part
 * is left out later, so the first source stays theirs.
 */
function registerPart(types: TypeSystemPlugin, part: unknown, bundleIds: ReadonlySet<string>, held: Held, isBase: boolean, source: string): string | undefined {
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
    // The store keeps the first definition of a type and ignores a different one; a part that brings one is left out,
    // with the name of the source that registered the type first.
    for (const schema of served.types) {
      const id = idOf(schema);
      const was = types.getSchema(id);
      const first = held.sources.get(id);
      if (was && canonical(was) !== canonical(schema)) return `its type ${id} is already defined otherwise${first ? ` by ${first}` : ''}`;
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
    for (const schema of served.types) {
      // Recorded per type once it registers, when `held.sources` has no entry for the id and the schema the store
      // holds for it equals the registered one in content (the store holds this source's own definition): a base
      // file re-registering on a retry of a failed call, whose types the store already holds, names the served
      // file again. A type the root registers itself before the file (a shared-property type, say) is never given
      // a source: the store holds its definition from before the file, so a file that carries a copy of it, alike
      // or otherwise, names no source of the type. The `held.sources` check keeps the first source: the store
      // keeps the types that registered when a later item of the same part fails, so they keep this source as
      // their first one.
      const id = idOf(schema);
      types.registerSchema(schema);
      if (!ROOT_TYPE_IDS.has(id) && !held.sources.has(id) && canonical(types.getSchema(id)) === canonical(schema)) held.sources.set(id, source);
    }
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
 * The name a console line gives a part: its manifest ids, quoted, escaped and capped (the ids come from the part, and
 * a line break in one would fake another console line), or its place in the answer.
 */
const partName = (ids: string[], index: number) => {
  const listed = ids.filter((id) => id.startsWith(MANIFEST_TYPE_PREFIX)).join(', ');
  return listed ? quoted(listed.length > NAME_CAP ? `${listed.slice(0, NAME_CAP)}...` : listed) : `number ${index + 2} of the answer (the served file is number 1)`;
};

/**
 * Step 2: the served file, or a dashboard-level failure. A host answers one
 * joined file, or the file in parts: the base file (the catalog types and the
 * dashboards), then one part per widget bundle. A rejected base file fails
 * every dashboard; a rejected widget part is left out with one console line,
 * its dashboards never load, and the root records the manifest and entry ids
 * and the type ids of a left-out part, and fails a cell by its widget type, a
 * type it extends, its entry, its render type or its data type with that part's line.
 */
export function registerServedFile(types: TypeSystemPlugin, file: unknown, bundleIds: ReadonlySet<string>): FileOutcome {
  const [base, ...parts] = Array.isArray(file) ? file : [file];
  // The stand-in records and the plugin's lifecycle stages, in the store before the file, count as held, so no part replaces them.
  const before = [...STAND_IN.instances, ...(loadLifecycleStages() as unknown as Record<string, unknown>[])];
  const held: Held = {
    instances: new Map(before.map((instance) => [idOfInstance(instance), canonical(instance)])),
    dashboards: new Map(),
    sources: new Map(),
  };
  const problem = guarded(() => registerPart(types, base, bundleIds, held, true, 'the served file'));
  if (problem) return { ok: false, problem: `the served file: ${problem}` };
  const rejected = { instances: new Map<string, string>(), types: new Map<string, string>() };
  parts.forEach((part, index) => {
    let ids: string[] = [];
    let typeIds: string[] = [];
    // The instance ids are read first, and the type ids in a guard of their own: a type whose `$id` cannot be read
    // is left out with the part, but must not take the part's name and its instance ids down with it, which the
    // cells of the type fail by.
    const reason = guarded(() => {
      const instances = isObject(part) && Array.isArray(part.instances) ? part.instances.filter(isObject) : [];
      ids = instances.map(idOfInstance).filter((id) => id && !id.startsWith(DASHBOARD_TYPE_ID));
      return registerPart(types, part, bundleIds, held, false, `the widget part ${partName(ids, index)}`);
    });
    guarded(() => {
      if (isObject(part) && Array.isArray(part.types)) typeIds = part.types.filter(isObject).map(idOf).filter(Boolean);
      return undefined;
    });
    if (!reason) {
      // A healthy part's own registration replaces what an earlier rejected part left under the same id.
      for (const id of ids) rejected.instances.delete(id);
      for (const id of typeIds) rejected.types.delete(id);
      return;
    }
    const name = partName(ids, index);
    // The reason quotes ids from the part as well (a registry message, an id held otherwise), so it is escaped the same way.
    const line = `the widget part ${name} is left out: ${escapeControls(reason)}`;
    console.error(`[dashboard] ${line}`);
    // A rejected part held nothing, so `held` still names what registered before it: those ids stay healthy. An
    // instance id is recorded only when nothing held it.
    for (const id of ids) if (!held.instances.has(id)) rejected.instances.set(id, line);
    // A type the store already has stays healthy, so only the types the part declared and did not register are recorded.
    for (const id of typeIds) if (!types.getSchema(id)) rejected.types.set(id, line);
  });
  return { ok: true, dashboards: held.dashboards, rejected };
}

/** The reason the widget's type, its entry, or its render or data type was left out with its part, or nothing. */
function leftOut(types: TypeSystemPlugin, widgetId: string, rejected: Rejected): string | undefined {
  if (rejected.types.size === 0 && rejected.instances.size === 0) return undefined;
  // A recorded type id counts only while the store still lacks the type: a part left out after the one that
  // declared the type may have registered it before failing on something else of its own, and then the cells of
  // the type mount. The entry lookup below stays on the record as it is: a part the registry rejects after its
  // entry registered must still fail its cells (DESIGN §3.6 step 4).
  const missingType = (id: string) => (types.getSchema(id) ? undefined : rejected.types.get(id));
  // The widget's type id, read once: it cannot throw, and everything below looks the same id up again.
  const typeId = typeOfWidget(widgetId);
  // The part that declared the widget's type, or one of the types it extends, by `$ref` or by a chained id's `~`
  // prefix, may be the one left out, before the type registered: its line, not the registry's, is the reason the
  // cell fails.
  const part = missingType(typeId) ?? missingAncestorLine(types, typeId, rejected);
  if (part) return part;
  try {
    const traits = effectiveTraits(types, typeId);
    const entry = typeof traits.entry === 'string' ? rejected.instances.get(traits.entry) : undefined;
    if (entry) return entry;
    // The type can sit in the base file with an entry of its own, so the entry names no left-out part while the
    // part's render and data type ids do: the cells of the type fail with the part's line all the same. A trait
    // that is no id, as a data_type a type has none of, names no part and is looked up by nothing.
    const dataType = traits.data_type;
    return missingType(renderTypeOf(types, typeId)) ?? (typeof dataType === 'string' ? missingType(dataType) : undefined);
  } catch {
    // A type that does not resolve fails the widget's own registration below.
    return undefined;
  }
}

/** The most `$ref` hops the ancestor walk takes before it gives up: a bound, so a chain of many parents cannot hang the lookup. */
const ANCESTOR_HOPS = 20;

/**
 * The line of the part that left out the first ancestor of the widget type that the store still lacks, or nothing.
 * The ancestors are the `$ref` members of the type's `allOf`, read the way the render type reads its own `allOf`,
 * and the walk goes on through the ancestors of a parent the store has. A chained id names its parents in the id
 * itself, the way `effectiveTraits` reads them: for every id the walk visits, the type itself and each ancestor it
 * reaches, each proper prefix of the id that ends in `~` is checked as an ancestor too, with the same rule as a
 * `$ref` one, and a prefix the store has is walked through. A recorded id counts only while the store
 * lacks the type (the `missingType` rule of `leftOut`). The smallest hop count seen per id and the hop bound keep a
 * cycle in the `$ref` chain or an unknown parent id from hanging or throwing out of the lookup, and a node the walk
 * reaches again with fewer hops is walked again, so a shared ancestor a long branch first reached near the bound is
 * still walked from a shorter branch: an ancestor the store lacks and no part
 * recorded names no left-out part, and the walk stops there.
 */
function missingAncestorLine(types: TypeSystemPlugin, typeId: string, rejected: Rejected): string | undefined {
  try {
    // The smallest hop count each id was reached at. A branch that reaches a node again with fewer hops than the
    // last walk through it walks it again, so a shared ancestor a long branch first reached at the bound is still
    // walked from a shorter branch and the part its ancestors answer with is named. Hops only grow along a walk,
    // so an id of a cycle never comes back with fewer hops and the bound still ends it.
    const best = new Map<string, number>();
    const walk = (id: string, hops: number): string | undefined => {
      if (hops > ANCESTOR_HOPS || (best.get(id) ?? Number.POSITIVE_INFINITY) <= hops) return undefined;
      best.set(id, hops);
      // The chained id's parents: each proper prefix that ends in `~`. One the store has is walked through; one it
      // lacks fails the cell only when a left-out part recorded it.
      const segments = id.split('~').filter(Boolean);
      for (let n = 1; n < segments.length; n += 1) {
        const prefix = `${segments.slice(0, n).join('~')}~`;
        const line = types.getSchema(prefix) ? walk(prefix, hops + 1) : rejected.types.get(prefix);
        if (line) return line;
      }
      const schema = types.getSchema(id) as { allOf?: unknown } | undefined;
      if (!schema) return undefined;
      const refs = (Array.isArray(schema.allOf) ? (schema.allOf as { $ref?: unknown }[]) : [])
        .map((member) => member?.$ref)
        .filter((ref): ref is string => typeof ref === 'string')
        .map((ref) => ref.replace(/^gts:\/\//, ''));
      for (const ref of refs) {
        // An ancestor the store has is walked through; one it lacks fails the cell only when a left-out part
        // recorded it.
        const line = types.getSchema(ref) ? walk(ref, hops + 1) : rejected.types.get(ref);
        if (line) return line;
      }
      return undefined;
    };
    return walk(typeId, 0);
  } catch {
    // A schema the store holds that cannot be read is the registry's reason to give, not this walk's.
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
export function registerDashboard(types: TypeSystemPlugin, dashboard: Dashboard, rejected: Rejected = { instances: new Map(), types: new Map() }): DashboardOutcome {
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
