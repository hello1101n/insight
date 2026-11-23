import type { MetricDimension } from "@/api/metric-results-client";

export function dimensionLabel(dimensions: MetricDimension[]): string {
  if (dimensions.length === 0) return "Total";
  return dimensions
    .map((dimension) => dimension.label ?? dimension.value)
    .join(" · ");
}

export function dimensionColorSeed(dimensions: MetricDimension[]): string {
  if (dimensions.length === 0) return "total";
  if (dimensions.length === 1) return dimensions[0]?.value ?? "total";
  return dimensions
    .map((dimension) => `${dimension.key}:${dimension.value}`)
    .join("|");
}

export function safeSeriesKey(raw: string): string {
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash * 33 + raw.charCodeAt(i)) | 0;
  }
  const suffix = (hash >>> 0).toString(36);
  return `${raw.replace(/[^a-zA-Z0-9_-]/g, "_")}_${suffix}`;
}

export function dimensionSeriesKey(dimensions: MetricDimension[]): string {
  if (dimensions.length === 0) return "total";
  return safeSeriesKey(
    dimensions
      .map((dimension) => `${dimension.key}:${dimension.value}`)
      .join("|"),
  );
}
