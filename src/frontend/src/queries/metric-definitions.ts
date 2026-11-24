import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  listMetricDefinitions,
  type MetricDefinition,
  type MetricDefinitionListResponse,
} from "@/api/metric-definitions-client";

export interface MetricDefinitionGroup {
  prefix: string;
  metrics: MetricDefinition[];
}

export function groupByKeyPrefix(
  metrics: MetricDefinition[]
): MetricDefinitionGroup[] {
  const groups = new Map<string, MetricDefinition[]>();
  for (const metric of metrics) {
    const dot = metric.metric_key.indexOf(".");
    const prefix =
      dot > 0 ? metric.metric_key.slice(0, dot) : metric.metric_key;
    const bucket = groups.get(prefix);
    if (bucket) {
      bucket.push(metric);
    } else {
      groups.set(prefix, [metric]);
    }
  }
  return [...groups.entries()].map(([prefix, grouped]) => ({
    prefix,
    metrics: grouped,
  }));
}

export function useMetricDefinitions(): UseQueryResult<
  MetricDefinitionGroup[]
> {
  return useQuery({
    queryKey: ["metric-definitions"],
    queryFn: listMetricDefinitions,
    staleTime: 5 * 60 * 1000,
    select: (data) => groupByKeyPrefix(data.metrics),
  });
}

export function useMetricDefinitionsResponse(): UseQueryResult<MetricDefinitionListResponse> {
  return useQuery({
    queryKey: ["metric-definitions"],
    queryFn: listMetricDefinitions,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCollectionBoundary(metricKey: string): CollectionBoundary {
  const definition = useMetricDefinition(metricKey);
  return {
    collectedFrom: definition?.first_observed_date ?? null,
    collectedThrough: definition?.last_observed_date ?? null,
    settledThrough: definition?.settled_through ?? null,
  };
}

export function useMetricDefinition(
  metricKey: string | null
): MetricDefinition | null {
  const { data } = useMetricDefinitionsResponse();
  return (
    data?.metrics.find((metric) => metric.metric_key === metricKey) ?? null
  );
}

export interface CollectionBoundary {
  collectedFrom: string | null;
  collectedThrough: string | null;
  settledThrough: string | null;
}

export interface DeclaredMetricDimensions {
  byMetricKey: ReadonlyMap<string, ReadonlySet<string>> | null;
  isPending: boolean;
}

export function useDeclaredMetricDimensions(): DeclaredMetricDimensions {
  const { data, isPending } = useQuery({
    queryKey: ["metric-definitions"],
    queryFn: listMetricDefinitions,
    staleTime: 5 * 60 * 1000,
  });
  const byMetricKey = useMemo(
    () =>
      data
        ? new Map(
            data.metrics.map((m) => [
              m.metric_key,
              new Set(m.dimensions) as ReadonlySet<string>,
            ])
          )
        : null,
    [data]
  );
  return { byMetricKey, isPending };
}

export interface AvailableMetricKeys {
  keys: ReadonlySet<string> | null;
  isPending: boolean;
}

export function useAvailableMetricKeys(): AvailableMetricKeys {
  const { data, isPending } = useQuery({
    queryKey: ["metric-definitions"],
    queryFn: listMetricDefinitions,
    staleTime: 5 * 60 * 1000,
  });
  const keys = useMemo(
    () =>
      data
        ? new Set(
            data.metrics
              .filter((m) => m.is_enabled && m.schema_status !== "error")
              .map((m) => m.metric_key)
          )
        : null,
    [data]
  );
  return { keys, isPending };
}
