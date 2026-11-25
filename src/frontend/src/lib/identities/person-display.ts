export interface PersonNaming {
  display_name?: string | null;
  username?: string | null;
  email?: string | null;
}

export function personName(person: PersonNaming): string | null {
  return (
    person.display_name?.trim() ||
    person.username?.trim() ||
    person.email?.trim() ||
    null
  );
}

export function personDisplayName(
  person: PersonNaming & { person_id: string },
): string {
  return personName(person) ?? person.person_id;
}
