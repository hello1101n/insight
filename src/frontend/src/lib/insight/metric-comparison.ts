import { formatMetricFigure } from "@/lib/format";
import { absenceLabel } from "@/lib/metrics/absence";
import { computeDelta, formatTileDelta } from "@/lib/metrics/delta";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

export interface MetricComparisons {
  absenceLabel?: string;
  change: string | null;
  median: string | null;
}

export function metricComparisons(
  metric: NormalizedMetricResult,
  previous: NormalizedMetricResult | null | undefined,
  entityId: string
): MetricComparisons {
  const data = forEntity(metric, entityId);
  const previousValue = previous ? forEntity(previous, entityId).value : null;
  const delta = computeDelta(
    data.value,
    previousValue,
    metric.computation,
    metric.format
  );
  const median = data.peer?.median ?? null;
  const label = absenceLabel(data.absence);
  return {
    ...(label ? { absenceLabel: label } : {}),
    change: delta ? formatTileDelta(delta) : null,
    median:
      median != null
        ? `median ${formatMetricFigure(median, metric.format, metric.unit)}`
        : null,
  };
}
