import { useQuery } from "@tanstack/react-query";

import type { SingleEntityEvidenceSelection } from "@/api/metric-drilldown-client";
import {
  queryMetricResults,
  type MetricResultsEntity,
  type MetricResultsResponse,
} from "@/api/metric-results-client";
import { sessionAuthorizationScope } from "@/auth/session-scope";
import { useAuth } from "@/auth/use-auth";
import type { DayReading } from "@/lib/insight/metric-grain";
import { retryServerFailureOnce } from "@/queries/retry-server-failure-once";

class MetricViewFailed extends Error {
  constructor(code: string) {
    super(`metric day series: ${code}`);
    this.name = "MetricViewFailed";
  }
}

function resultsEntity(
  selection: SingleEntityEvidenceSelection
): MetricResultsEntity {
  switch (selection.entity.type) {
    case "person":
      return { type: "person", ids: [selection.entity.id] };
    case "tenant":
      return { type: "tenant" };
  }
}

export interface MetricDaySeries {
  readings: DayReading[];
  notReady: boolean;
}

function daySeries(
  response: MetricResultsResponse,
  metricKey: string
): MetricDaySeries {
  const metric = response.metrics.find((m) => m.metric_key === metricKey);
  const failed = metric?.views.find((v) => v.view === "error");
  if (failed?.view === "error") {
    throw new MetricViewFailed(failed.code);
  }
  if (metric?.views.some((v) => v.view === "not_ready")) {
    return { readings: [], notReady: true };
  }
  const view = metric?.views.find((v) => v.view === "timeseries");
  if (view?.view !== "timeseries") return { readings: [], notReady: false };

  const byDate = new Map<string, DayReading>();
  for (const series of view.series) {
    for (const point of series.points) {
      if (
        point.value == null &&
        point.numerator == null &&
        point.denominator == null
      ) {
        continue;
      }
      const isRatio = point.numerator != null || point.denominator != null;
      const day = byDate.get(point.bucket_start) ?? {
        date: point.bucket_start,
        value: 0,
        numerator: isRatio ? 0 : null,
        denominator: isRatio ? 0 : null,
      };
      day.value += point.value ?? 0;
      if (isRatio) {
        day.numerator = (day.numerator ?? 0) + (point.numerator ?? 0);
        day.denominator = (day.denominator ?? 0) + (point.denominator ?? 0);
      }
      byDate.set(point.bucket_start, day);
    }
  }

  return {
    readings: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    notReady: false,
  };
}

export function useMetricDaySeries(
  selection: SingleEntityEvidenceSelection | null | undefined,
  enabled = true
) {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  const entity = selection ? resultsEntity(selection) : null;

  return useQuery({
    queryKey: ["metric-day-series", sessionScope, selection],
    queryFn: async ({ signal }) => {
      if (!selection || !entity) {
        throw new Error("Metric day series selection is missing");
      }
      const response = await queryMetricResults(
        {
          entity,
          period: selection.period,
          metrics: [
            {
              metric_key: selection.metric_key,
              filters: selection.filters,
              views: [{ view: "timeseries", bucket: "day" }],
            },
          ],
        },
        signal
      );
      return daySeries(response, selection.metric_key);
    },
    enabled:
      enabled && sessionScope != null && selection != null && entity != null,
    retry: (failureCount, error) =>
      !(error instanceof MetricViewFailed) &&
      retryServerFailureOnce(failureCount, error),
  });
}
