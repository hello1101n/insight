import type { MetricGroup } from "@/lib/insight/groups";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

const SYSTEM_DIMENSIONS = new Set(["tool", "source"]);

export function sectionSources(
  def: MetricGroup,
  byKey: Map<string, NormalizedMetricResult>,
  entityId: string
): string[] {
  const names = new Set<string>();
  for (const m of def.collection.metrics) {
    const metric = byKey.get(m.key);
    if (!metric) continue;
    for (const row of forEntity(metric, entityId).breakdown) {
      if ((row.value ?? 0) <= 0) continue;
      for (const dimension of row.dimensions) {
        if (!SYSTEM_DIMENSIONS.has(dimension.key)) continue;
        const name = dimension.label ?? dimension.value;
        if (name) names.add(name);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
