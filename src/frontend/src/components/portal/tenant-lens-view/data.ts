import {
  forEntity,
  type EntityMetricData,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

export function tenantData(r: NormalizedMetricResult): EntityMetricData {
  const id = soleEntityId(r);
  return forEntity(r, id ?? "");
}

export function hasRealReading(e: EntityMetricData): boolean {
  return (
    e.value != null ||
    e.series.some((s) => s.points.some((p) => p.value != null)) ||
    e.breakdown.some((v) => v.value != null) ||
    e.histogram.some((h) => h.bins.length > 0)
  );
}

function soleEntityId(r: NormalizedMetricResult): string | null {
  return (
    r.period?.values[0]?.entity_id ??
    r.timeseries?.series[0]?.entity_id ??
    r.breakdown?.values[0]?.entity_id ??
    r.histogram?.values[0]?.entity_id ??
    null
  );
}
