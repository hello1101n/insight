import type { PeopleListItem } from "@/api/identity-client";
import type { IdentityPerson } from "@/types/insight";

export interface SliceAttr {
  key: string;
  label: string;
  value: string;
}

export interface SliceDim {
  key: string;
  label: string;
  planned?: boolean;
}

const MIN_DISTINCT = 2;
const MAX_DISTINCT = 60;
const MAX_UNIQUE_RATIO = 0.9;

const ATTR_FIELDS: readonly {
  key: string;
  label: string;
  get: (p: IdentityPerson) => string | null | undefined;
}[] = [
  { key: "division", label: "Division", get: (p) => p.division },
  { key: "department", label: "Department", get: (p) => p.department },
  { key: "title", label: "Title", get: (p) => p.job_title },
  { key: "manager", label: "Manager", get: (p) => p.supervisor_email },
];

export function personAttributes(p: IdentityPerson): Record<string, SliceAttr> {
  const out: Record<string, SliceAttr> = {};
  for (const f of ATTR_FIELDS) {
    const value = (f.get(p) ?? "").trim();
    if (value) out[f.key] = { key: f.key, label: f.label, value };
  }
  return out;
}

export const PLANNED_SLICES: readonly SliceDim[] = [];

export function availableSlices(
  rosters: Iterable<Record<string, SliceAttr>>,
): SliceDim[] {
  const label = new Map<string, string>();
  const order: string[] = [];
  const distinct = new Map<string, Set<string>>();
  const count = new Map<string, number>();

  for (const attrs of rosters) {
    for (const key of Object.keys(attrs)) {
      const a = attrs[key]!;
      if (!label.has(key)) {
        label.set(key, a.label);
        order.push(key);
        distinct.set(key, new Set());
      }
      distinct.get(key)!.add(a.value);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }

  return order
    .filter((key) => {
      const d = distinct.get(key)!.size;
      const n = count.get(key) ?? 0;
      return d >= MIN_DISTINCT && d <= MAX_DISTINCT && d / n < MAX_UNIQUE_RATIO;
    })
    .map((key) => ({ key, label: label.get(key)! }));
}

export function collectRosterAttrs(
  root: IdentityPerson | null,
  keyOf: (personId: string) => string,
): Map<string, Record<string, SliceAttr>> {
  const m = new Map<string, Record<string, SliceAttr>>();
  const walk = (n: IdentityPerson) => {
    if (n.person_id) m.set(keyOf(n.person_id), personAttributes(n));
    n.subordinates.forEach(walk);
  };
  if (root) walk(root);
  return m;
}

const ROSTER_ATTRIBUTE_ALIASES: Readonly<
  Record<string, { key: string; label: string }>
> = {
  department: { key: "department", label: "Department" },
  division: { key: "division", label: "Division" },
  job_title: { key: "title", label: "Title" },
  status: { key: "status", label: "Status" },
};

export function collectPeopleAttrs(
  roster: readonly PeopleListItem[],
  keyOf: (personId: string) => string,
): Map<string, Record<string, SliceAttr>> {
  const byPerson = new Map<string, Record<string, SliceAttr>>();
  const onRoster = new Set(roster.map((person) => keyOf(person.person_id)));

  for (const person of roster) {
    const attributes: Record<string, SliceAttr> = {};
    for (const [sourceKey, rawValue] of Object.entries(person.attributes)) {
      const value = rawValue.trim();
      if (!value) continue;
      const descriptor = ROSTER_ATTRIBUTE_ALIASES[sourceKey] ?? {
        key: sourceKey,
        label: sourceKey,
      };
      attributes[descriptor.key] = { ...descriptor, value };
    }
    if (
      person.manager_person_id &&
      onRoster.has(keyOf(person.manager_person_id))
    ) {
      attributes.manager = {
        key: "manager",
        label: "Manager",
        value: person.manager_person_id,
      };
    }
    byPerson.set(keyOf(person.person_id), attributes);
  }

  return byPerson;
}

export function cohortKey(
  attrs: Record<string, SliceAttr> | undefined,
  slice: string,
): string | null {
  if (!slice) return "all";
  return attrs?.[slice]?.value ?? null;
}
