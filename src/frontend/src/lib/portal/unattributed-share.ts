export interface UnattributedScope {
  personal: boolean;
  scoped: boolean;
  mayReadOrganisation: boolean;
  scopeMemberCount: number;
  visibleCount: number;
}

export function showsUnattributedShare(scope: UnattributedScope): boolean {
  if (scope.personal || scope.scoped || !scope.mayReadOrganisation) {
    return false;
  }

  return scope.visibleCount > 0 && scope.scopeMemberCount >= scope.visibleCount;
}
