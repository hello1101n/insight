import type {
  MetricComputation,
  MetricDirection,
  MetricFormat,
} from "@/api/metric-results-client";
import { MULTIPLE_THRESHOLD, formatMultiple, formatPp } from "@/lib/format";
import type { Status } from "@/lib/status";

export type MetricDelta =
  | { kind: "percent_change"; value: number }
  | { kind: "pp_change"; value: number };

export function computeDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  computation: MetricComputation,
  format: MetricFormat,
): MetricDelta | null {
  if (
    current == null ||
    previous == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  ) {
    return null;
  }

  if (computation === "ratio" && format === "percent") {
    return { kind: "pp_change", value: current - previous };
  }

  if (previous === 0) return null;
  return {
    kind: "percent_change",
    value: ((current - previous) / Math.abs(previous)) * 100,
  };
}

const TRIVIAL_PERCENT_CHANGE = 2;
const TRIVIAL_PP_CHANGE = 1;

export function isTrivialDelta(delta: MetricDelta): boolean {
  return (
    Math.abs(delta.value) <=
    (delta.kind === "pp_change" ? TRIVIAL_PP_CHANGE : TRIVIAL_PERCENT_CHANGE)
  );
}

export function deltaStatus(
  delta: MetricDelta,
  direction: MetricDirection,
): Status {
  if (direction === "neutral" || isTrivialDelta(delta)) return "neutral";
  const favorable =
    direction === "lower_is_better" ? delta.value < 0 : delta.value > 0;
  return favorable ? "good" : "bad";
}

export interface ShownDelta {
  text: string;
  status: Status;
  down: boolean;
}

export function shownDelta(
  delta: MetricDelta,
  direction: MetricDirection,
): ShownDelta {
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

export function formatTileDelta(delta: MetricDelta): string | null {
  if (delta.kind === "pp_change") {
    return Math.round(Math.abs(delta.value)) === 0
      ? null
      : formatPp(delta.value, 0);
  }
  const rounded = Math.round(delta.value);
  if (rounded === 0) return null;
  const ratio = 1 + delta.value / 100;
  if (ratio >= MULTIPLE_THRESHOLD) return formatMultiple(ratio);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
