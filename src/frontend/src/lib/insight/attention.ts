import type {
  MetricDirection,
  MetricFormat,
} from "@/api/metric-results-client";
import { formatMetricValue, splitMetricValue } from "@/lib/format";
import { formatGapMagnitude } from "@/lib/metrics/gap";
import type { MetricGroup, GroupId } from "@/lib/insight/groups";
import { dropRedundantMetrics } from "@/lib/insight/metric-containment";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { derivePeerStanding, peerSpread } from "@/lib/metrics/peer-standing";
import type { PeerStats } from "@/lib/peers";

const ADVERSE_MOVE_MIN_SPREADS = 0.25;

const BEHIND_MIN_REL_GAP = 0.75;

const BEHIND_MIN_MEDIAN_EVENTS = 5;

export interface AttentionItem {
  key: string;
  group: GroupId;
  label: string;
  valueText: string;
  valueNumber: string;
  valueUnit: string;
  medianText: string | null;
  gapText: string | null;
  spreadGap: number;
  relGap: number;
  kind: "fell" | "behind";
  direction: MetricDirection;
  noPrevious: boolean;
}

export function metricAttentionItems(
  def: MetricGroup,
  byKey: Map<string, NormalizedMetricResult>,
  previousByKey: Map<string, NormalizedMetricResult> | null,
  entityId: string,
  renderedHeadlineKeys: ReadonlySet<string>
): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const metricConfig of def.collection.metrics) {
    if (renderedHeadlineKeys.has(metricConfig.key)) continue;
    const metric = byKey.get(metricConfig.key);
    if (!metric) continue;
    const data = forEntity(metric, entityId);
    if (data.absence?.period_overlap) continue;
    const value = data.value;
    const standing = derivePeerStanding(metric.direction, data);
    if (!standing.eligible || standing.rank !== "bottom") continue;
    if (value == null || !Number.isFinite(value)) continue;
    const stats = standing.stats;
    if (!stats) continue;
    const higherIsBetter = metric.direction !== "lower_is_better";
    const before = previousByKey?.get(metricConfig.key);
    const previous = before ? forEntity(before, entityId).value : null;
    const hasPrevious = previous != null && Number.isFinite(previous);

    const median = stats.p50;
    const denom = Math.abs(median) > 1e-9 ? Math.abs(median) : 1;
    const relGap = higherIsBetter
      ? (median - value) / denom
      : (value - median) / denom;

    const fell =
      !data.absence?.compare_to_overlap &&
      hasPrevious &&
      fellAgainstOwnPast(value, previous, stats, higherIsBetter);
    const behind = farBehindCohort(relGap, median, metric.format);
    if (!fell && !behind) continue;
    const gapDelta = value - median;
    const split = splitMetricValue(value, metric.format, metric.unit);
    items.push({
      key: metric.metric_key,
      group: def.id,
      label: metric.label,
      valueText: formatMetricValue(value, metric.format, metric.unit),
      valueNumber: split.number,
      valueUnit: split.unit,
      medianText: formatMetricValue(median, metric.format, metric.unit),
      gapText: formatGapMagnitude({
        value,
        median,
        gapPct: Math.abs(median) > 1e-9 ? gapDelta / Math.abs(median) : null,
        gapDelta,
        format: metric.format,
        unit: metric.unit,
      }),
      spreadGap: standing.spreadGap,
      relGap,
      kind: fell ? "fell" : "behind",
      direction: metric.direction,
      noPrevious: !hasPrevious,
    });
  }
  return items;
}

function fellAgainstOwnPast(
  value: number,
  previous: number,
  stats: PeerStats,
  higherIsBetter: boolean
): boolean {
  const worse = higherIsBetter ? value < previous : value > previous;
  const movedSpreads = Math.abs(value - previous) / peerSpread(stats);
  return worse && movedSpreads >= ADVERSE_MOVE_MIN_SPREADS;
}

function farBehindCohort(
  relGap: number,
  median: number,
  format: MetricFormat
): boolean {
  const cohortDoesEnough =
    format !== "integer" || Math.abs(median) >= BEHIND_MIN_MEDIAN_EVENTS;
  return relGap >= BEHIND_MIN_REL_GAP && cohortDoesEnough;
}

export type AttentionOrder = "standing-first" | "changes-first";

export function orderAttentionItems(
  items: readonly AttentionItem[],
  renderedHeadlineKeys: ReadonlySet<string>,
  order: AttentionOrder = "standing-first"
): AttentionItem[] {
  const leadingKind = order === "changes-first" ? "fell" : "behind";
  const leads = (item: AttentionItem) => Number(item.kind === leadingKind);
  const ranked = [...items].sort(
    (a, b) =>
      leads(b) - leads(a) ||
      (a.kind === "behind" ? b.relGap - a.relGap : b.spreadGap - a.spreadGap) ||
      b.relGap - a.relGap
  );
  return dropRedundantMetrics(ranked, renderedHeadlineKeys);
}
