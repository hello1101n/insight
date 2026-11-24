import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  fetchPersonalMetrics,
  fetchPersonalValues,
  type PersonalMetric,
  type PersonalValuesRequest,
} from "@/api/personal-metrics-client";
import type { DateRange } from "@/api/period-to-date-range";
import {
  chunkEntityIds,
  mergeNormalizedResults,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { normalizePersonId } from "@/lib/metrics/entity";
import { chunkKeys } from "@/lib/portal/metrics-view";
import {
  exclusiveEnd,
  isPersonalKey,
  personalDefinition,
  personalResults,
  PERSONAL_PREFIX,
  type PersonalMetricDefinition,
} from "@/lib/portal/personal-metrics";
import {
  useMetricCollectionSet,
  type KeyedCollection,
} from "@/queries/metric-results";

export const MAX_METRICS_PER_REQUEST = 50;
export const MAX_PEOPLE_PER_PERSONAL_REQUEST = 1000;

const NO_PERSONAL: readonly PersonalMetricDefinition[] = [];

export interface MetricsViewData {
  byKey: Map<string, NormalizedMetricResult>;
  isPending: boolean;
  isError: boolean;
  personalError: boolean;
  refetch: () => void;
}

function toDefinitions(metrics: PersonalMetric[]): PersonalMetricDefinition[] {
  return metrics.map(personalDefinition);
}

export function usePersonalMetricDefinitions() {
  return useQuery({
    queryKey: ["personal-metrics"],
    queryFn: fetchPersonalMetrics,
    staleTime: 5 * 60 * 1000,
    select: toDefinitions,
  });
}

export function useMetricsViewData(
  metricKeys: readonly string[],
  personIds: string[],
  range: DateRange,
  personal: readonly PersonalMetricDefinition[] = NO_PERSONAL,
): MetricsViewData {
  const analyticsKeys = useMemo(
    () => metricKeys.filter((key) => !isPersonalKey(key)),
    [metricKeys],
  );
  const personalKeys = useMemo(() => metricKeys.filter(isPersonalKey), [metricKeys]);
  const collections = useMemo<readonly KeyedCollection[]>(
    () =>
      chunkKeys(analyticsKeys, MAX_METRICS_PER_REQUEST).map((chunk, index) => ({
        key: `metrics-view-${index}`,
        collection: {
          metrics: chunk.map((key) => ({ key, views: [{ view: "period" }] })),
        },
      })),
    [analyticsKeys],
  );
  const entity = useMemo(
    () => ({ type: "person" as const, ids: personIds }),
    [personIds],
  );

  const set = useMetricCollectionSet(collections, entity, range);
  const own = usePersonalValues(personalKeys, personIds, range, personal);

  const results = [...set.values()];

  return {
    byKey: new Map([...results.flatMap((result) => [...result.byKey]), ...own.byKey]),
    isPending: results.some((result) => result.isPending) || own.isPending,
    isError: results.some((result) => result.isError),
    personalError: own.isError,
    refetch: () => {
      for (const result of results) result.refetch();
      own.refetch();
    },
  };
}

function usePersonalValues(
  keys: readonly string[],
  personIds: readonly string[],
  range: DateRange,
  definitions: readonly PersonalMetricDefinition[],
) {
  const requests = useMemo(() => {
    if (!range.from || !range.to) return [];

    const ids = [...new Set(personIds.map(normalizePersonId).filter(Boolean))].sort();
    if (ids.length === 0) return [];

    const { from, to } = exclusiveEnd(range);
    return chunkKeys(keys, MAX_METRICS_PER_REQUEST).flatMap((chunk) =>
      chunkEntityIds(ids, MAX_PEOPLE_PER_PERSONAL_REQUEST).map((chunkIds) => ({
        keys: chunk,
        request: {
          metrics: chunk.map((key) => key.slice(PERSONAL_PREFIX.length)),
          person_ids: chunkIds,
          from,
          to,
        } satisfies PersonalValuesRequest,
      })),
    );
  }, [keys, personIds, range]);

  const queries = useQueries({
    queries: requests.map(({ request }) => ({
      queryKey: ["personal-metrics", "values", request],
      queryFn: () => fetchPersonalValues(request),
    })),
  });

  const merged = mergeNormalizedResults(
    requests.map(({ keys: chunk }, index) => {
      const data = queries[index]?.data;
      return data ? personalResults(data, chunk) : new Map<string, NormalizedMetricResult>();
    }),
  );
  const byKey = new Map<string, NormalizedMetricResult>();
  for (const definition of definitions) {
    if (!keys.includes(definition.metric_key)) continue;

    byKey.set(definition.metric_key, {
      metric_key: definition.metric_key,
      label: definition.label,
      ...(definition.description ? { description: definition.description } : {}),
      unit: definition.unit,
      computation: "sum",
      format: definition.format,
      direction: definition.direction,
      period: merged.get(definition.metric_key)?.period,
    });
  }

  return {
    byKey,
    isPending: queries.some((query) => query.isPending),
    isError: queries.some((query) => query.isError),
    refetch: () => {
      for (const query of queries) void query.refetch();
    },
  };
}
