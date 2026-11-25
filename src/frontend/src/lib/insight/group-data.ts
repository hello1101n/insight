import type { MetricGroup } from "@/lib/insight/groups";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { derivePeerStanding } from "@/lib/metrics/peer-standing";
import type { PeerStatusWithNeutral } from "@/lib/peers";

export function groupHasData(
  def: MetricGroup,
  byKey: Map<string, NormalizedMetricResult>,
  entityId: string,
): boolean {
  return def.collection.metrics.some((m) => {
    const metric = byKey.get(m.key);
    return metric != null && forEntity(metric, entityId).value != null;
  });
}

const HEADLINE_TIER: Record<PeerStatusWithNeutral, number> = {
  bottom: 3,
  in_pack: 2,
  top: 1,
  neutral: 0,
};

export function groupHeadlineKey(
  def: MetricGroup,
  byKey: Map<string, NormalizedMetricResult>,
  entityId: string,
): string | null {
  let best: { key: string; tier: number; severity: number } | null = null;
  let firstWithValue: string | null = null;
  for (const m of def.collection.metrics) {
    const metric = byKey.get(m.key);
    if (!metric) continue;
    const data = forEntity(metric, entityId);
    if (data.value != null && firstWithValue == null) firstWithValue = m.key;
    const standing = derivePeerStanding(metric.direction, {
      value: data.value,
      peer: metric.peer?.values.find((v) => v.entity_id === entityId) ?? null,
      absence: data.absence,
    });
    if (standing.rank === "neutral") continue;
    const candidate = {
      key: m.key,
      tier: HEADLINE_TIER[standing.rank],
      severity: standing.severity,
    };
    if (
      !best ||
      candidate.tier > best.tier ||
      (candidate.tier === best.tier && candidate.severity > best.severity)
    ) {
      best = candidate;
    }
  }
  return best?.key ?? firstWithValue;
}
