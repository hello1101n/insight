import type { MetricDirection } from "@/api/metric-results-client";
import type { EntityMetricData, PeerEntityStats } from "@/lib/metrics/collection";
import {
  peerStatusVsQuartiles,
  type PeerStats,
  type PeerStatusWithNeutral,
} from "@/lib/peers";

type StandingReason =
  | "time_off"
  | "ok"
  | "no_value"
  | "neutral_direction"
  | "unmeasured"
  | "no_stats"
  | "flat_pool";

export interface PeerStanding {
  observed: boolean;
  stats: PeerStats | null;
  eligible: boolean;
  reason: StandingReason;
  rank: PeerStatusWithNeutral;
  gapDelta: number;
  gapPct: number | null;
  severity: number;
  spreadGap: number;
}

export function toPeerStats(row: PeerEntityStats | null): PeerStats | null {
  if (
    row?.p25 == null ||
    row.median == null ||
    row.p75 == null ||
    row.min == null ||
    row.max == null
  ) {
    return null;
  }
  return {
    p25: row.p25,
    p50: row.median,
    p75: row.p75,
    min: row.min,
    max: row.max,
    n: row.n,
  };
}

export function peerSpread(stats: PeerStats): number {
  const iqr = Math.abs(stats.p75 - stats.p25);
  if (iqr > 1e-9) return iqr;
  const range = Math.abs(stats.max - stats.min);
  if (range > 1e-9) return range;
  return 1;
}

export function derivePeerStanding(
  direction: MetricDirection,
  data: Pick<EntityMetricData, "value" | "peer" | "absence">,
): PeerStanding {
  const value = data.value;
  const stats = toPeerStats(data.peer);
  const observed = data.peer == null || data.peer.target_value != null;
  const higherIsBetter = direction !== "lower_is_better";

  const gapDelta = stats != null && value != null ? value - stats.p50 : 0;
  const gapPct =
    stats != null && Math.abs(stats.p50) > 1e-9
      ? gapDelta / Math.abs(stats.p50)
      : null;

  const ineligible = (reason: Exclude<StandingReason, "ok">): PeerStanding => ({
    observed,
    stats,
    eligible: false,
    reason,
    rank: "neutral",
    gapDelta,
    gapPct,
    severity: 0,
    spreadGap: 0,
  });

  if (value == null || !Number.isFinite(value)) return ineligible("no_value");
  if (direction === "neutral") return ineligible("neutral_direction");
  if (!observed) return ineligible("unmeasured");
  if (stats == null) return ineligible("no_stats");
  if (Math.abs(stats.max - stats.min) <= 1e-9) return ineligible("flat_pool");
  if (data.absence?.period_overlap) return ineligible("time_off");

  return {
    observed,
    stats,
    eligible: true,
    reason: "ok",
    rank: peerStatusVsQuartiles(value, stats, higherIsBetter),
    gapDelta,
    gapPct,
    severity: Math.abs(gapPct ?? gapDelta / peerSpread(stats)),
    spreadGap: Math.abs(gapDelta) / peerSpread(stats),
  };
}
