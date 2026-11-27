import { useQuery } from "@tanstack/react-query";

import {
  queryMetricDrilldown,
  type MetricEvidenceSelection,
} from "@/api/metric-drilldown-client";
import { sessionAuthorizationScope } from "@/auth/session-scope";
import { useAuth } from "@/auth/use-auth";
import { retryServerFailureOnce } from "@/queries/retry-server-failure-once";

export const DETAIL_LIMIT = 200;

export function useMetricDetail(
  selection: MetricEvidenceSelection | null | undefined,
  enabled = true
) {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  return useQuery({
    queryKey: ["metric-drilldown", sessionScope, selection, DETAIL_LIMIT],
    queryFn: ({ signal }) => {
      if (!selection) throw new Error("Metric detail selection is missing");
      return queryMetricDrilldown(
        { ...selection, limit: DETAIL_LIMIT },
        signal
      );
    },
    enabled: enabled && sessionScope != null && selection != null,
    retry: retryServerFailureOnce,
  });
}
