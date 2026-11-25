import type { ChartConfig } from "@gears-frontx/ui-kit";
import type { MouseHandlerDataParam } from "recharts";

import type { MetricResult } from "@/api/custom-client";
import { chartColor } from "@/lib/chart-palette";

export function points(
  result: MetricResult,
  keys: string[]
): Record<string, unknown>[] {
  const indexes = keys.map(
    (key) => [key, result.columns.indexOf(key)] as const
  );

  return result.rows.map((row) =>
    Object.fromEntries(indexes.map(([key, at]) => [key, row[at]]))
  );
}

export interface Stacks {
  rows: Record<string, unknown>[];
  series: { key: string; label: string }[];
  total: string;
  top: string;
}

const STACK_TOTAL = "stack-total";
const STACK_TOP = "stack-top";
export function stackColor(index: number): string {
  return chartColor(index);
}

// WORKAROUND: Recharts reads a dotted `dataKey` as a path, so a series value is never a key.
// INVARIANT: with gaps, a series with no value at an x holds null there, so a line breaks instead of dropping to 0.
export function stacks(
  result: MetricResult,
  x: string,
  y: string,
  series: string,
  gaps = false
): Stacks {
  const xAt = result.columns.indexOf(x);
  const yAt = result.columns.indexOf(y);
  const seriesAt = result.columns.indexOf(series);

  const label = (row: unknown[]) => String(row[seriesAt] ?? "—");
  const labels = [...new Set(result.rows.map(label))].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true })
  );
  const keys = new Map(labels.map((name, index) => [name, `stack-${index}`]));
  const bars = new Map<unknown, Record<string, unknown>>();

  for (const row of result.rows) {
    const key = keys.get(label(row))!;

    const bar = bars.get(row[xAt]) ?? { [x]: row[xAt], [STACK_TOTAL]: 0 };
    bars.set(row[xAt], bar);
    if (gaps && row[yAt] == null) continue;

    const amount = Number(row[yAt]);
    const value = Number.isFinite(amount) ? amount : 0;
    bar[key] = Number(bar[key] ?? 0) + value;
    bar[STACK_TOTAL] = Number(bar[STACK_TOTAL]) + value;
  }

  const ordered = [...keys.values()];
  const rows = [...bars.values()].map((bar) => ({
    ...Object.fromEntries(ordered.map((key) => [key, gaps ? null : 0])),
    ...bar,
    [STACK_TOP]: ordered.findLast((key) => Number(bar[key] ?? 0) > 0),
  }));

  return {
    rows,
    series: [...keys].map(([label, key]) => ({ key, label })),
    total: STACK_TOTAL,
    top: STACK_TOP,
  };
}

export function seriesConfig(key: string, index = 0): ChartConfig {
  return {
    [key]: { label: key, color: chartColor(index) },
  };
}

export interface DrawnSeries {
  rows: Record<string, unknown>[];
  series: { key: string; label: string }[];
  config: ChartConfig;
  stacked: Stacks | null;
}

export function drawnSeries(
  result: MetricResult,
  x: string,
  y: string,
  series: string | undefined,
  gaps = false
): DrawnSeries {
  if (!series) {
    return {
      rows: points(result, [x, y]),
      series: [{ key: y, label: y }],
      config: seriesConfig(y),
      stacked: null,
    };
  }

  const stacked = stacks(result, x, y, series, gaps);
  return {
    rows: stacked.rows,
    series: stacked.series,
    config: Object.fromEntries(
      stacked.series.map(({ key, label }, index) => [
        key,
        { label, color: stackColor(index) },
      ])
    ),
    stacked,
  };
}

export function pointClick(
  onPointClick: (() => void) | undefined
): ((state: MouseHandlerDataParam) => void) | undefined {
  if (!onPointClick) return undefined;

  // WORKAROUND: Recharts reports a click between points as a null index.
  return (state) => {
    if (state.activeTooltipIndex != null) onPointClick();
  };
}

export type { ChartConfig };
