import type { MetricFormat } from "@/api/metric-results-client";
import {
  MULTIPLE_THRESHOLD,
  formatMetricValue,
  formatMultiple,
  formatPp,
  roundMetricValue,
} from "@/lib/format";

function formatGapPct(gap: number): string | null {
  const pct = Math.round(Math.abs(gap) * 100);
  if (pct === 0) return null;
  return `${gap >= 0 ? "+" : "-"}${pct}%`;
}

export interface GapInput {
  value: number;
  median: number | null;
  gapPct: number | null;
  gapDelta: number;
  format: MetricFormat;
  unit: string | null;
}

function displayedIntegerGap(input: GapInput): GapInput {
  if (input.median == null) return input;
  const value = roundMetricValue(input.value, "integer");
  const median = roundMetricValue(input.median, "integer");
  const gapDelta = value - median;
  const gapPct = median === 0 ? null : gapDelta / Math.abs(median);
  return { ...input, value, median, gapPct, gapDelta };
}

function displayedPercentGap({ value, median, gapDelta }: GapInput): number {
  if (median == null) return Math.round(gapDelta);
  return Math.round(value) - Math.round(median);
}

export function formatGapMagnitude(input: GapInput): string | null {
  const { value, median, gapPct, gapDelta, format, unit } =
    input.format === "integer" ? displayedIntegerGap(input) : input;

  if (format === "percent") {
    const points = displayedPercentGap(input);
    return points === 0 ? null : formatPp(points, 0);
  }
  if (
    median != null &&
    Math.abs(median) > 1e-9 &&
    value / median >= MULTIPLE_THRESHOLD
  ) {
    return formatMultiple(value / median);
  }
  if (gapPct != null) return formatGapPct(gapPct);
  const magnitude = formatMetricValue(Math.abs(gapDelta), format, unit);
  if (/^0(?:\.0)?(?:\D|$)/.test(magnitude)) return null;
  const sign = gapDelta >= 0 ? "+" : "-";
  return `${sign}${magnitude}`;
}
