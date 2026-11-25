import type { PeopleListItem } from "@/api/identity-client";
import type { IdentityPerson } from "@/types/insight";

export function pid(label: string): string {
  const hex = [...label]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
  const body = (hex + "1".repeat(32)).slice(0, 32);
  return [
    body.slice(0, 8),
    body.slice(8, 12),
    body.slice(12, 16),
    body.slice(16, 20),
    body.slice(20, 32),
  ].join("-");
}

export function identityPerson(
  label: string,
  over: Partial<IdentityPerson> = {},
  subordinates: IdentityPerson[] = [],
): IdentityPerson {
  return {
    person_id: pid(label),
    email: `${label}@x`,
    display_name: label,
    subordinates,
    ...over,
  } as unknown as IdentityPerson;
}

export function peopleFromIdentityTree(
  root: IdentityPerson,
  managerPersonId: string | null = null,
  managerName: string | null = null,
): PeopleListItem[] {
  return [
    {
      person_id: root.person_id,
      display_name: root.display_name,
      first_name: root.first_name ?? null,
      last_name: root.last_name ?? null,
      username: root.username ?? null,
      email: root.email,
      attributes: {
        ...(root.department ? { department: root.department } : {}),
        ...(root.division ? { division: root.division } : {}),
        ...(root.job_title ? { job_title: root.job_title } : {}),
        ...(root.status ? { status: root.status } : {}),
      },
      manager_person_id: managerPersonId,
      manager_name: managerName,
    },
    ...root.subordinates.flatMap((report) =>
      peopleFromIdentityTree(report, root.person_id, root.display_name || null),
    ),
  ];
}
