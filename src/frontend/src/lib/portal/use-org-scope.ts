import { useMemo } from "react";

import { useViewer } from "@/auth";
import {
  findIdentityNode,
  flattenSubordinates,
  hasIndirectReports,
  rosterTree,
  scopeRosterToDirectReports,
  type RosterEntry,
} from "@/lib/insight/identity-tree";
import { usePortalScope } from "@/lib/portal/portal-nav";
import type { OrgScope } from "@/lib/portal/portal-store";
import type { PeopleListItem } from "@/api/identity-client";
import { personDisplayName } from "@/lib/identities/person-display";
import { useVisibilityPolicy } from "@/queries/identity-me";
import { useVisibleRoster } from "@/queries/visible-roster";
import type { IdentityPerson } from "@/types/insight";

export interface ManagerNode {
  person_id: string;
  name: string;
  depth: number;
  subtreeMemberCount: number;
  directMemberCount: number;
}

export interface ResolvedScope {
  pivot: IdentityPerson | null;
  roster: RosterEntry[] | null;
  label: string;
  rosterCount: number;
  scopeMemberCount: number;
  managerNodes: ManagerNode[];
  canDirectOnly: boolean;
}

export const WHOLE_ORG_LABEL = "Whole organisation";

export function flatOrgScope(
  roster: readonly PeopleListItem[] | null,
): ResolvedScope {
  if (!roster) {
    return {
      pivot: null,
      roster: null,
      label: WHOLE_ORG_LABEL,
      rosterCount: 0,
      scopeMemberCount: 0,
      managerNodes: [],
      canDirectOnly: false,
    };
  }

  const members: RosterEntry[] = roster.map((person) => ({
    person_id: person.person_id,
    email: person.email ?? "",
    display_name: person.display_name ?? "",
    username: person.username ?? "",
    supervisor_person_id: null,
    is_direct: false,
  }));

  return {
    pivot: null,
    roster: members,
    label: WHOLE_ORG_LABEL,
    rosterCount: members.length,
    scopeMemberCount: members.length,
    managerNodes: [],
    canDirectOnly: false,
  };
}

export function resolveScopeRoster(
  tree: IdentityPerson | null,
  viewerPersonId: string | null,
  scope: OrgScope,
): ResolvedScope {
  if (!tree) {
    return {
      pivot: null,
      roster: null,
      label: "",
      rosterCount: 0,
      scopeMemberCount: 0,
      managerNodes: [],
      canDirectOnly: false,
    };
  }
  const viewerNode =
    (viewerPersonId ? findIdentityNode(tree, viewerPersonId) : null) ?? tree;
  const pivot =
    (scope.root ? findIdentityNode(viewerNode, scope.root) : null) ?? viewerNode;
  const full = flattenSubordinates(pivot);
  const canDirectOnly = hasIndirectReports(full);
  const roster = scopeRosterToDirectReports(full, canDirectOnly && scope.directOnly);

  const managerNodes: ManagerNode[] = [];
  const walk = (node: IdentityPerson, depth: number): number => {
    const entry =
      node.subordinates.length > 0
        ? {
            person_id: node.person_id,
            name: personDisplayName(node),
            depth,
            subtreeMemberCount: 0,
            directMemberCount: node.subordinates.length + 1,
          }
        : null;
    if (entry) managerNodes.push(entry);
    let memberCount = 1;
    for (const sub of node.subordinates) memberCount += walk(sub, depth + 1);
    if (entry) entry.subtreeMemberCount = memberCount;
    return memberCount;
  };
  walk(viewerNode, 0);

  return {
    pivot,
    roster,
    label: personDisplayName(pivot),
    rosterCount: roster?.length ?? 0,
    scopeMemberCount: (roster?.length ?? 0) + 1,
    managerNodes,
    canDirectOnly,
  };
}

export function useOrgScope(): ResolvedScope & {
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  pivotPersonId: string;
} {
  const { personId } = useViewer();
  const scope = usePortalScope();
  const { isFlat } = useVisibilityPolicy();
  const visibleRoster = useVisibleRoster(true);
  const tree = useMemo(
    () =>
      visibleRoster.isPending || !personId
        ? null
        : rosterTree(visibleRoster.roster, personId),
    [visibleRoster.isPending, visibleRoster.roster, personId],
  );

  const resolved = useMemo(
    () =>
      isFlat
        ? flatOrgScope(visibleRoster.isPending ? null : visibleRoster.roster)
        : resolveScopeRoster(tree, personId, scope),
    [isFlat, visibleRoster.isPending, visibleRoster.roster, tree, personId, scope],
  );

  return {
    ...resolved,
    isLoading: visibleRoster.isPending,
    isError: visibleRoster.isError,
    refetch: visibleRoster.retry,
    pivotPersonId: resolved.pivot?.person_id ?? personId ?? "",
  };
}
