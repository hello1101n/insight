let lastSynced: string | null = null;

export function claimScopeSync(personId: string): boolean {
  if (!personId || lastSynced === personId) return false;
  lastSynced = personId;
  return true;
}

export function resetRouteScopeSync(): void {
  lastSynced = null;
}
