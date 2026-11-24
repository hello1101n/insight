export function normalizePersonId(personId: string): string {
  return personId.trim().toLowerCase();
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export function isPersonId(value: string): boolean {
  const normalized = normalizePersonId(value);
  return UUID_RE.test(normalized) && normalized !== NIL_UUID;
}
