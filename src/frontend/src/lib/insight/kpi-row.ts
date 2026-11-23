import type { MetricDirection } from "@/api/metric-results-client";
import { formatMetricFigure, formatPp } from "@/lib/format";
import {
  KPI_ROW,
  KPI_ROW_MAX,
  groupIdForMetricKey,
  type GroupId,
} from "@/lib/insight/groups";
import {
  entityObserved,
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { dropRedundantMetrics } from "@/lib/insight/metric-containment";
import { peerStatusToStatus } from "@/lib/insight/peer-status";
import { formatGapMagnitude } from "@/lib/metrics/gap";
import { derivePeerStanding } from "@/lib/metrics/peer-standing";
import {
  computeDelta,
  deltaStatus,
  formatTileDelta,
  type MetricDelta,
} from "@/lib/metrics/delta";
import type { Status } from "@/lib/status";
import { absenceLabel } from "@/lib/metrics/absence";

export interface KpiTileData {
  absenceLabel?: string | null;
  key: string;
  label: string;
  value: string;
  delta: { text: string; status: Status; down: boolean } | null;
  medianLabel: string | null;
  gapText: string | null;
  gapStatus: Status;
  groupId: GroupId | null;
}

function tileDelta(
  delta: MetricDelta,
  direction: MetricDirection
): NonNullable<KpiTileData["delta"]> {
  const text = formatTileDelta(delta);
  if (text == null) {
    const unchanged = delta.kind === "pp_change" ? formatPp(0, 0) : "±0%";
    return { text: unchanged, status: "neutral", down: false };
  }
  return {
    text,
    status: deltaStatus(delta, direction),
    down: delta.value < 0,
  };
}

export function metricKpiTiles(
  byKey: Map<string, NormalizedMetricResult>,
  previousByKey: Map<string, NormalizedMetricResult> | null,
  entityId: string
): KpiTileData[] {
  const tiles = KPI_ROW.flatMap((metricKey) => {
    const metric = byKey.get(metricKey);
    if (!metric) return [];
    if (!entityObserved(metric, entityId)) return [];

    const data = forEntity(metric, entityId);
    const leaveLabel = absenceLabel(data.absence);
    const value = data.value;
    const median = data.peer?.median ?? null;
    const standing = derivePeerStanding(metric.direction, data);
    const gapStatus = peerStatusToStatus(standing.rank);

    const previousMetric = previousByKey?.get(metricKey) ?? null;
    const previousValue = previousMetric
      ? forEntity(previousMetric, entityId).value
      : null;
    const rawDelta: MetricDelta | null =
      value === 0 && previousValue === 0
        ? { kind: "percent_change", value: 0 }
        : computeDelta(value, previousValue, metric.computation, metric.format);
    const delta = rawDelta
      ? tileDelta(rawDelta, leaveLabel ? "neutral" : metric.direction)
      : null;

    const gapText =
      (standing.eligible || standing.reason === "time_off") &&
      value != null &&
      Math.abs(standing.gapDelta) > 1e-9
        ? formatGapMagnitude({
            value,
            median,
            gapPct: standing.gapPct,
            gapDelta: standing.gapDelta,
            format: metric.format,
            unit: metric.unit,
          })
        : null;

    return [
      {
        key: metric.metric_key,
        absenceLabel: leaveLabel,
        label: metric.label,
        value: formatMetricFigure(value, metric.format, metric.unit),
        delta,
        medianLabel:
          median != null
            ? `median ${formatMetricFigure(median, metric.format, metric.unit)}`
            : null,
        gapText,
        gapStatus,
        groupId: groupIdForMetricKey(metric.metric_key),
      },
    ];
  });
  return dropRedundantMetrics(tiles).slice(0, KPI_ROW_MAX);
}
