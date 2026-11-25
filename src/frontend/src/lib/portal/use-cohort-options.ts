import { useMemo } from "react";

import { collectPeopleAttrs } from "@/lib/insight/slices";
import { normalizePersonId } from "@/lib/metrics/entity";
import {
  catalogAttributes,
  cohortOptions,
  type CohortOptions,
} from "@/lib/portal/cohort-options";
import { usePortalSlice } from "@/lib/portal/portal-nav";
import { useMetricDefinitionsResponse } from "@/queries/metric-definitions";
import { useVisibleRoster } from "@/queries/visible-roster";

export interface CohortOptionsState extends CohortOptions {
  isPending: boolean;
  slice: string;
}

export function useCohortOptions(): CohortOptionsState {
  const stored = usePortalSlice();
  const definitions = useMetricDefinitionsResponse();
  const roster = useVisibleRoster(true);

  const options = useMemo(
    () =>
      cohortOptions(
        catalogAttributes(definitions.data),
        collectPeopleAttrs(roster.roster, normalizePersonId).values(),
      ),
    [definitions.data, roster.roster],
  );

  const isPending = definitions.isPending || roster.isPending;
  return {
    ...options,
    isPending,
    slice:
      isPending || options.dims.some((d) => d.key === stored) ? stored : "",
  };
}
