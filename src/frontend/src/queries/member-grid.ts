import { useMemo } from "react";

import type { DateRange } from "@/api/period-to-date-range";
import {
  projectViews,
  type MetricCollectionConfig,
  type MetricCollectionEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import {
  useMetricCollectionSet,
  type KeyedCollection,
} from "@/queries/metric-results";

const GRID_KEY = "member-grid";

export interface MemberGridData {
  byKey: Map<string, NormalizedMetricResult>;
  previousByKey: Map<string, NormalizedMetricResult>;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
}

const EMPTY = new Map<string, NormalizedMetricResult>();

export function useMemberGridData(
  collection: MetricCollectionConfig,
  entity: MetricCollectionEntity,
  range: DateRange,
  compareTo: DateRange,
): MemberGridData {
  const collections = useMemo<readonly KeyedCollection[]>(
    () => [
      {
        key: GRID_KEY,
        collection: projectViews(collection, ["period", "peer"]),
      },
    ],
    [collection],
  );
  const set = useMetricCollectionSet(collections, entity, range, compareTo);
  const grid = set.get(GRID_KEY);

  return {
    byKey: grid?.byKey ?? EMPTY,
    previousByKey: grid?.previousByKey ?? EMPTY,
    isPending: grid?.isPending ?? false,
    isFetching: grid?.isFetching ?? false,
    isError: grid?.isError ?? false,
    refetch: () => {
      grid?.refetch();
    },
  };
}
