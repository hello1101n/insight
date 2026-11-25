import type { MetricDimensionFilter } from "@/api/metric-results-client";
import type { MetricCollectionConfig } from "@/lib/metrics/collection";
import type { SectionSpec } from "@/lib/portal/lens-configs";

export const HOUR_BLOCK_DIMENSION = "hour_block";

type BreakdownSection = Extract<
  SectionSpec,
  { kind: "composition" | "ownership" }
>;
type HeatmapSection = Extract<SectionSpec, { kind: "heatmap-hours" }>;

export function breakdownRequest(
  sections: readonly BreakdownSection[],
  scopeFilters: MetricDimensionFilter[] | undefined
): MetricCollectionConfig {
  const dimensionsByMetric = new Map<string, Set<string>>();
  for (const s of sections) {
    const dimensions = dimensionsByMetric.get(s.metric) ?? new Set<string>();
    dimensions.add(s.dimension);
    if (s.kind === "composition" && s.splitBy) dimensions.add(s.splitBy);
    dimensionsByMetric.set(s.metric, dimensions);
  }
  return {
    metrics: [...dimensionsByMetric].map(([key, dimensions]) => ({
      key,
      ...(scopeFilters ? { filters: scopeFilters } : {}),
      views: [{ view: "breakdown" as const, dimensions: [...dimensions] }],
    })),
  };
}

export function heatmapRequest(
  sections: readonly HeatmapSection[],
  scopeFilters: MetricDimensionFilter[] | undefined
): MetricCollectionConfig {
  return {
    metrics: sections.map((s) => ({
      key: s.metric,
      ...(scopeFilters ? { filters: scopeFilters } : {}),
      views: [
        {
          view: "timeseries" as const,
          bucket: "day" as const,
          dimensions: [HOUR_BLOCK_DIMENSION],
        },
      ],
    })),
  };
}
