import { parseISOCalendarDate } from "@/api/period-to-date-range";

export interface RangePreset {
  token: string;
  label: string;
  short: string;
}

export const RANGE_PRESETS: readonly RangePreset[] = [
  { token: "PDC", label: "Yesterday", short: "Yday" },
  { token: "P7D", label: "Last 7 days", short: "7d" },
  { token: "P30D", label: "Last 30 days", short: "30d" },
  { token: "PMC", label: "Last month", short: "Month" },
  { token: "PQC", label: "Last quarter", short: "Qtr" },
  { token: "P1Y", label: "Last 365 days", short: "1y" },
  { token: "inf", label: "All time", short: "All" },
] as const;

const LABELS = new Map(RANGE_PRESETS.map(({ token, label }) => [token, label]));

export interface DateInterval {
  from: string;
  to: string;
}

export function toInterval(token: string): DateInterval | undefined {
  const parts = token.split("/");
  if (parts.length !== 2) return undefined;

  const [from, to] = parts;
  if (!parseISOCalendarDate(from) || !parseISOCalendarDate(to)) return undefined;
  if (from >= to) return undefined;

  return { from, to };
}

export function isRangeToken(token: string): boolean {
  return LABELS.has(token) || toInterval(token) !== undefined;
}

export function rangeLabel(token: string): string {
  const preset = LABELS.get(token);
  if (preset) return preset;

  const interval = toInterval(token);
  return interval ? `${interval.from} – ${interval.to}` : token;
}

export function toRangeToken({ from, to }: DateInterval): string {
  return `${from}/${to}`;
}

const DAILY_PRESETS = new Set(["P7D", "P30D", "PMC"]);

const DAY_MS = 86_400_000;

// INVARIANT: this mirrors the bucket grain that insight-v3-core picks for a range, in domain/query/time_window.rs.
export function dailyBuckets(range: string | undefined): boolean {
  if (range === undefined) return false;
  if (DAILY_PRESETS.has(range)) return true;

  const interval = toInterval(range);
  if (!interval) return false;

  const days = (Date.parse(interval.to) - Date.parse(interval.from)) / DAY_MS;
  return days >= 2 && days <= 31;
}
