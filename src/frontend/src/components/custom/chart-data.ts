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

export function projected(
  result: MetricResult,
  columns: readonly string[]
): MetricResult {
  const indexes = columns.map((column) => result.columns.indexOf(column));

  return {
    ...result,
    columns: [...columns],
    rows: result.rows.map((row) => indexes.map((at) => row[at])),
  };
}

export const FUNNEL_STAGE = "stage";
export const FUNNEL_VALUE = "value";

// INVARIANT: each stage is a column of the one result row, in the listed order.
export function funnelStages(
  result: MetricResult,
  stages: readonly string[]
): MetricResult {
  const [first] = projected(result, stages).rows;
  const all = (marked: string[] | undefined) =>
    stages.every((stage) => marked?.includes(stage));

  return {
    columns: [FUNNEL_STAGE, FUNNEL_VALUE],
    rows: stages.map((stage, index) => [stage, first?.[index] ?? null]),
    ...(all(result.percents) ? { percents: [FUNNEL_VALUE] } : {}),
  };
}

export function largestFirst(
  result: MetricResult,
  label: string,
  value: string
): MetricResult {
  const drawn = projected(result, [label, value]);
  const size = (row: unknown[]) => {
    const amount = Number(row[1]);
    return row[1] == null || !Number.isFinite(amount) ? -Infinity : amount;
  };

  return { ...drawn, rows: drawn.rows.toSorted((a, b) => size(b) - size(a)) };
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

export interface ScatterPoint {
  x: number;
  y: number;
  size: number | null;
  label: unknown;
}

export interface ScatterGroup {
  key: string;
  label: string;
  points: ScatterPoint[];
}

export function scatterGroups(
  result: MetricResult,
  columns: {
    x: string;
    y: string;
    size?: string;
    series?: string;
    label?: string;
  }
): ScatterGroup[] {
  const at = (column: string | undefined) =>
    column === undefined ? -1 : result.columns.indexOf(column);
  const [xAt, yAt, sizeAt, seriesAt, labelAt] = [
    at(columns.x),
    at(columns.y),
    at(columns.size),
    at(columns.series),
    at(columns.label),
  ];
  const groups = new Map<string, ScatterPoint[]>();

  for (const row of result.rows) {
    const x = finite(row[xAt]);
    const y = finite(row[yAt]);
    if (x === null || y === null) continue;

    const name = seriesAt < 0 ? columns.y : String(row[seriesAt] ?? "—");
    const points = groups.get(name) ?? [];
    groups.set(name, points);
    points.push({
      x,
      y,
      size: sizeAt < 0 ? null : finite(row[sizeAt]),
      label: labelAt < 0 ? undefined : row[labelAt],
    });
  }

  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([label, points], index) => ({
      key: `scatter-${index}`,
      label,
      points,
    }));
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
