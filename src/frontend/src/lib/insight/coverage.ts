import type { GroupId, MetricGroup } from "@/lib/insight/groups";
import type { MetricDefinition } from "@/api/metric-definitions-client";
import type { DisplayText } from "@/i18n/localized-text";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

export type PartState = "reads" | "nothing_recorded" | "no_data_reaches_us";

export function reachableMetricKeys(
  definitions: readonly MetricDefinition[],
): Set<string> {
  const out = new Set<string>();
  for (const d of definitions) {
    if (!d.is_enabled) continue;
    if (d.schema_status === "error") continue;
    if (d.origin !== "custom" && d.last_observed_date == null) continue;
    out.add(d.metric_key);
  }
  return out;
}

export function partState(
  def: MetricGroup,
  byKey: Map<string, NormalizedMetricResult>,
  entityId: string,
  reachable: ReadonlySet<string>,
): PartState {
  let anyReachable = false;
  for (const m of def.collection.metrics) {
    const metric = byKey.get(m.key);
    if (metric != null && forEntity(metric, entityId).value != null) {
      return "reads";
    }
    if (reachable.has(m.key)) anyReachable = true;
  }
  return anyReachable ? "nothing_recorded" : "no_data_reaches_us";
}

export interface UnreachablePart {
  id: GroupId;
  title: DisplayText;
}

export function unreachableParts(
  groups: readonly MetricGroup[],
  reachable: ReadonlySet<string>,
): UnreachablePart[] {
  return groups
    .filter((def) => !def.collection.metrics.some((m) => reachable.has(m.key)))
    .map((def) => ({ id: def.id, title: def.title }));
}
