import {
  forEntity,
  type EntityMetricData,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

export function tenantData(r: NormalizedMetricResult): EntityMetricData {
  const id = firstEntityId(r);
  return forEntity(r, id ?? "");
}

function firstEntityId(r: NormalizedMetricResult): string | null {
  return (
    r.period?.values[0]?.entity_id ??
    r.timeseries?.series[0]?.entity_id ??
    r.breakdown?.values[0]?.entity_id ??
    r.histogram?.values[0]?.entity_id ??
    null
  );
}
