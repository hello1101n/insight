import type { IdentityPerson } from "@/types/insight";

export interface OrgTreeFilter {
  visible: ReadonlySet<string>;
  matched: ReadonlySet<string>;
}

function haystack(person: IdentityPerson): string {
  return [
    person.display_name,
    person.username,
    person.email,
    person.job_title,
    person.department,
    person.division,
    person.supervisor_name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function filterOrgTree(
  root: IdentityPerson | null,
  query: string
): OrgTreeFilter | null {
  const needle = query.trim().toLowerCase();
  if (!root || needle === "") return null;

  const visible = new Set<string>();
  const matched = new Set<string>();

  const walk = (person: IdentityPerson, ancestors: string[]): void => {
    if (haystack(person).includes(needle)) {
      matched.add(person.person_id);
      visible.add(person.person_id);
      for (const ancestor of ancestors) visible.add(ancestor);
    }
    const deeper = [...ancestors, person.person_id];
    for (const report of person.subordinates) walk(report, deeper);
  };
  walk(root, []);

  return { visible, matched };
}
