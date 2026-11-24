import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  queryMetricResults,
  type MetricRequest,
} from "@/api/metric-results-client";
import type { DateRange } from "@/api/period-to-date-range";
import {
  buildMetricCollectionRequest,
  chunkEntityIds,
  filterCollectionByKey,
  filterCollectionToAvailable,
  filterCollectionToDeclaredDimensions,
  entityChunkSize,
  mergeNormalizedResults,
  normalizeMetricResults,
  projectComparison,
  projectPrimary,
  type MetricCollectionConfig,
  type MetricCollectionEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { normalizePersonId } from "@/lib/metrics/entity";
import { metricVisible } from "@/lib/portal/nav-policy";
import { usePortalShowPlanned } from "@/lib/portal/portal-store";
import {
  useAvailableMetricKeys,
  useDeclaredMetricDimensions,
} from "@/queries/metric-definitions";

function useMetricGate(): (metricKey: string) => boolean {
  const showPlanned = usePortalShowPlanned();
  return useMemo(
    () => (metricKey: string) => metricVisible(metricKey, showPlanned),
    [showPlanned]
  );
}

export interface MetricCollectionOptions {
  compareTo?: DateRange;
  keepPreviousData?: boolean;
}

export interface MetricCollectionResult {
  byKey: Map<string, NormalizedMetricResult>;
  previousByKey: Map<string, NormalizedMetricResult> | null;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
}

function canonicalEntityIds(entity: MetricCollectionEntity): string[] {
  if (entity.type === "tenant") return [];
  const ids = entity.ids.map(normalizePersonId);
  return [...new Set(ids.filter(Boolean))].sort();
}

function entitySelected(
  entity: MetricCollectionEntity,
  ids: string[]
): boolean {
  return entity.type === "tenant" || ids.length > 0;
}

function queryKeyFor(
  entity: MetricCollectionEntity,
  ids: string[],
  range: DateRange,
  metrics: MetricRequest[],
  compareTo?: DateRange
) {
  return [
    "metric-results",
    entity.type,
    ids,
    range.from,
    range.to,
    metrics,
    compareTo ?? null,
  ] as const;
}

export function useMetricCollection(
  collection: MetricCollectionConfig,
  entity: MetricCollectionEntity,
  range: DateRange,
  options?: MetricCollectionOptions
): MetricCollectionResult {
  const ids = canonicalEntityIds(entity);
  const catalog = useAvailableMetricKeys();
  const dimensions = useDeclaredMetricDimensions();
  const gate = useMetricGate();
  const asked = filterCollectionByKey(
    filterCollectionToDeclaredDimensions(
      filterCollectionToAvailable(collection, catalog.keys),
      dimensions.byMetricKey
    ),
    gate
  );
  const canonicalEntity: MetricCollectionEntity =
    entity.type === "person" ? { type: "person", ids } : { type: "tenant" };
  const compareTo = options?.compareTo;
  const request = buildMetricCollectionRequest(
    asked,
    canonicalEntity,
    range,
    compareTo
  );
  const enabled =
    entitySelected(entity, ids) &&
    request.metrics.length > 0 &&
    !catalog.isPending &&
    !dimensions.isPending &&
    Boolean(range.from && range.to);

  const current = useQuery({
    queryKey: queryKeyFor(entity, ids, range, request.metrics, compareTo),
    queryFn: () => queryMetricResults(request),
    enabled,
    placeholderData: options?.keepPreviousData ? keepPreviousData : undefined,
  });

  const served = useMemo(
    () => normalizeMetricResults(current.data?.metrics, current.data?.absence_context),
    [current.data]
  );
  const byKey = useMemo(() => projectPrimary(served), [served]);
  const previousByKey = compareTo ? projectComparison(served) : null;

  return {
    byKey,
    previousByKey,
    isPending:
      (current.isPending && enabled) ||
      (entitySelected(entity, ids) &&
        (catalog.isPending || dimensions.isPending)),
    isFetching: current.isFetching,
    isError: enabled && current.isError,
    refetch: () => {
      // WORKAROUND: react-query's `refetch()` ignores `enabled`.
      if (!enabled) return;
      void current.refetch();
    },
  };
}

export interface KeyedCollection {
  key: string;
  collection: MetricCollectionConfig;
}

export function collectionSetPending(
  set: Map<string, MetricCollectionResult>
): boolean {
  return [...set.values()].some((result) => result.isPending);
}

export function useMetricCollectionSet(
  collections: readonly KeyedCollection[],
  entity: MetricCollectionEntity,
  range: DateRange,
  compareTo?: DateRange
): Map<string, MetricCollectionResult> {
  const ids = canonicalEntityIds(entity);
  const catalog = useAvailableMetricKeys();
  const dimensions = useDeclaredMetricDimensions();
  const gate = useMetricGate();
  const enabled =
    entitySelected(entity, ids) &&
    !catalog.isPending &&
    !dimensions.isPending &&
    Boolean(range.from && range.to);

  const requests = collections.flatMap(({ key, collection: raw }) => {
    const collection = filterCollectionByKey(
      filterCollectionToDeclaredDimensions(
        filterCollectionToAvailable(raw, catalog.keys),
        dimensions.byMetricKey
      ),
      gate
    );
    const chunkSize = entityChunkSize(collection);
    const chunks =
      entity.type === "tenant" || chunkSize === null
        ? [ids]
        : chunkEntityIds(ids, chunkSize);
    return chunks.map((chunkIds) => {
      const request = buildMetricCollectionRequest(
        collection,
        entity.type === "person"
          ? { type: "person", ids: chunkIds }
          : { type: "tenant" },
        range,
        compareTo
      );
      return {
        key,
        request,
        chunkIds,
        active: enabled && request.metrics.length > 0,
      };
    });
  });

  const results = useQueries({
    queries: requests.map(({ request, chunkIds, active }) => ({
      queryKey: queryKeyFor(entity, chunkIds, range, request.metrics, compareTo),
      queryFn: () => queryMetricResults(request),
      enabled: active,
    })),
  });

  const out = new Map<string, MetricCollectionResult>();
  const chunkMaps = new Map<
    string,
    Array<Map<string, NormalizedMetricResult>>
  >();
  requests.forEach(({ key, active }, index) => {
    const query = results[index];
    if (!query) return;
    const maps = chunkMaps.get(key) ?? [];
    maps.push(normalizeMetricResults(query.data?.metrics, query.data?.absence_context));
    chunkMaps.set(key, maps);
    const existing = out.get(key);
    // WORKAROUND: react-query's `refetch()` ignores `enabled`.
    const refetch = () => {
      if (active) void query.refetch();
    };
    out.set(key, {
      byKey: new Map(),
      previousByKey: null,
      isPending:
        (existing?.isPending ?? false) ||
        (query.isPending && active) ||
        (entitySelected(entity, ids) &&
          (catalog.isPending || dimensions.isPending)),
      isFetching: (existing?.isFetching ?? false) || query.isFetching,
      isError: (existing?.isError ?? false) || (active && query.isError),
      refetch: existing
        ? () => {
            existing.refetch();
            refetch();
          }
        : refetch,
    });
  });
  for (const [key, maps] of chunkMaps) {
    const entry = out.get(key);
    if (!entry) continue;
    const served = mergeNormalizedResults(maps);
    entry.byKey = projectPrimary(served);
    entry.previousByKey = compareTo ? projectComparison(served) : null;
  }
  return out;
}

export interface UnattributedShares {
  byKey: Map<string, number | null>;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useUnattributedShares(
  metricKeys: readonly string[],
  anchorId: string | null,
  range: DateRange
): UnattributedShares {
  const collection = useMemo<MetricCollectionConfig>(
    () => ({
      metrics: metricKeys.map((key) => ({
        key,
        views: [{ view: "unattributed" }],
      })),
    }),
    [metricKeys]
  );
  const result = useMetricCollection(
    collection,
    { type: "person", ids: anchorId ? [anchorId] : [] },
    range
  );

  const byKey = useMemo(
    () =>
      new Map(
        [...result.byKey].map(([key, metric]) => [
          key,
          metric.unattributed?.value ?? null,
        ])
      ),
    [result.byKey]
  );

  return {
    byKey,
    isPending: result.isPending,
    isError: result.isError,
    refetch: result.refetch,
  };
}
