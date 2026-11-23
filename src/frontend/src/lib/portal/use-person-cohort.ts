import { useMemo } from "react";

import { cohortKey, collectPeopleAttrs } from "@/lib/insight/slices";
import { normalizePersonId } from "@/lib/metrics/entity";
import { useCohortOptions } from "@/lib/portal/use-cohort-options";
import { useVisibleRoster } from "@/queries/visible-roster";

export function usePersonCohort(entityId: string): string[] {
  const { slice } = useCohortOptions();
  const roster = useVisibleRoster(true).roster;
  const attrByEntity = useMemo(
    () => collectPeopleAttrs(roster, normalizePersonId),
    [roster],
  );
  return useMemo(() => {
    if (!slice) return [];
    const own = cohortKey(attrByEntity.get(entityId), slice);
    if (own == null) return [];
    return [...attrByEntity.entries()]
      .filter(([, a]) => cohortKey(a, slice) === own)
      .map(([id]) => id);
  }, [attrByEntity, slice, entityId]);
}
