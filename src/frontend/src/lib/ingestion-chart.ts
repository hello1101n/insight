import type {
  IngestionGrain,
  IngestionPoint,
  IngestionSeries,
} from "@/api/ingestion-client";
import { chartColor } from "@/lib/chart-palette";

export const TOTAL_KEY = "all";

// WORKAROUND: Recharts draws a log-axis bar from the axis minimum, so a floor of 1 gives a one-row bucket zero height.
export const LOG_FLOOR = 0.5;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

// WORKAROUND: Date.parse reads a zone-less date-time as local time; the server buckets in UTC.
export function bucketToEpoch(bucket: string): number {
  return Date.parse(`${bucket.replace(" ", "T")}Z`);
}

export function formatUtcBucket(epoch: number, grain: IngestionGrain): string {
  const at = new Date(epoch);
  const clock = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
  if (grain === "1s") return `${clock}:${pad(at.getUTCSeconds())}`;
  return `${pad(at.getUTCDate())} ${MONTHS[at.getUTCMonth()]} ${clock}`;
}

export function formatUtcDay(epoch: number): string {
  const at = new Date(epoch);
  return `${pad(at.getUTCDate())} ${MONTHS[at.getUTCMonth()]}`;
}

export function seriesColorVar(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return chartColor(hash);
}

export interface PivotRow {
  epoch: number;
  total: number;
  [key: string]: number;
}

export interface Pivoted {
  rows: PivotRow[];
  keys: string[];
}

export function pivotIntensity(points: readonly IngestionPoint[]): Pivoted {
  const byBucket = new Map<number, PivotRow>();
  const totals = new Map<string, number>();

  for (const point of points) {
    const epoch = bucketToEpoch(point.bucket);
    if (Number.isNaN(epoch)) continue;
    const row = byBucket.get(epoch) ?? { epoch, total: 0 };
    row[point.key] = (row[point.key] ?? 0) + point.rows;
    row.total += point.rows;
    byBucket.set(epoch, row);
    totals.set(point.key, (totals.get(point.key) ?? 0) + point.rows);
  }

  const keys = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);

  return {
    rows: [...byBucket.values()].sort((a, b) => a.epoch - b.epoch),
    keys,
  };
}

export function totalsByKey(
  points: readonly IngestionPoint[],
): Array<{ key: string; rows: number }> {
  const totals = new Map<string, number>();
  for (const point of points) {
    totals.set(point.key, (totals.get(point.key) ?? 0) + point.rows);
  }
  return [...totals.entries()]
    .map(([key, rows]) => ({ key, rows }))
    .sort((a, b) => b.rows - a.rows || a.key.localeCompare(b.key));
}

export function logDomain(peak: number): [number, number] {
  return [LOG_FLOOR, Math.max(peak, 1)];
}

// WORKAROUND: Recharts log ticks include the fractional LOG_FLOOR, printing 0.5 on a whole-row axis.
export function logTicks(maxValue: number): number[] {
  const ticks = [1];
  while (ticks[ticks.length - 1] < maxValue) {
    ticks.push(ticks[ticks.length - 1] * 10);
  }
  return ticks;
}

export function bandLabel(key: string, series: IngestionSeries): string {
  return series === "total" && key === TOTAL_KEY ? "All connectors" : key;
}

export function connectorLabel(sourceDatabase: string): string {
  return sourceDatabase.replace(/^bronze_/, "");
}

export function scopeForConnector(connector: string): string {
  return connector.startsWith("bronze_") ? connector : `bronze_${connector}`;
}

const MS_PER_DAY = 86_400_000;

export function lookbackFrom(now: number, days: number): string {
  const startOfDay = Math.floor(now / MS_PER_DAY) * MS_PER_DAY;
  return new Date(startOfDay - days * MS_PER_DAY).toISOString();
}

export function bucketMs(grain: IngestionGrain): number {
  return grain === "1s" ? 1_000 : 15 * 60 * 1_000;
}

// WORKAROUND: Recharts centres a bar on its value on a numeric axis, clipping the edge buckets by half a width.
export function paddedDomain(
  from: string,
  to: string,
  grain: IngestionGrain,
): [number, number] {
  const half = bucketMs(grain) / 2;
  return [Date.parse(from) - half, Date.parse(to) + half];
}
