import { format, formatDistance, parseISO } from "date-fns";
import { enUS } from "date-fns/locale";

import type { MetricFormat } from "@/api/metric-results-client";
import { LOCALE } from "@/config/constants";

const NF_THOUSANDS = new Intl.NumberFormat(LOCALE);

const METRIC_CURRENCY_FORMAT = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export const NO_METRIC_VALUE = "—";

export function roundMetricValue(v: number, fmt: MetricFormat): number {
  return fmt === "decimal" ? Math.round(v * 10) / 10 : Math.round(v);
}

export const HOURS_UNIT = "h";

const WHOLE_HOURS_FROM = 100;

export function isDurationUnit(unit?: string | null): boolean {
  return unit === HOURS_UNIT;
}

const TIME_UNITS: ReadonlySet<string> = new Set([HOURS_UNIT, "min", "d"]);

export interface MetricValueFormat {
  format: MetricFormat;
  unit: string | null;
}

export function formatTimeMetricValue(
  value: unknown,
  metric: MetricValueFormat | null,
): string | null {
  return metric?.unit != null &&
    TIME_UNITS.has(metric.unit) &&
    typeof value === "number"
    ? formatMetricValue(value, metric.format, metric.unit)
    : null;
}

export function formatHoursDuration(hours: number): string {
  const sign = hours < 0 ? "-" : "";
  const abs = Math.abs(hours);
  if (abs >= WHOLE_HOURS_FROM) {
    return `${sign}${NF_THOUSANDS.format(Math.round(abs))} ${HOURS_UNIT}`;
  }
  const totalMinutes = Math.round(abs * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${sign}${m} min`;
  if (m === 0) return `${sign}${h} ${HOURS_UNIT}`;
  return `${sign}${h} ${HOURS_UNIT} ${m} min`;
}

export function formatClockDuration(hours: number): string {
  const sign = hours < 0 ? "-" : "";
  const totalMinutes = Math.round(Math.abs(hours) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = String(totalMinutes % 60).padStart(2, "0");
  return `${sign}${NF_THOUSANDS.format(h)} ${HOURS_UNIT} ${m} min`;
}

export function formatMetricNumber(
  v: number | null | undefined,
  fmt: MetricFormat,
): string {
  if (v == null || !Number.isFinite(v)) return NO_METRIC_VALUE;
  const rounded = roundMetricValue(v, fmt);
  if (fmt === "currency") return METRIC_CURRENCY_FORMAT.format(rounded);
  return NF_THOUSANDS.format(rounded);
}

export function formatMetricValue(
  v: number | null | undefined,
  fmt: MetricFormat,
  unit?: string | null,
): string {
  if (v == null || !Number.isFinite(v)) return NO_METRIC_VALUE;
  const s = formatMetricNumber(v, fmt);
  if (fmt === "currency") return s;
  if (fmt === "percent") return `${s}%`;
  if (isDurationUnit(unit)) return formatHoursDuration(v);
  return unit ? `${s} ${unit}` : s;
}

export function formatMetricFigure(
  v: number | null | undefined,
  fmt: MetricFormat,
  unit?: string | null,
): string {
  return metricDisplayUnit(fmt, unit)
    ? formatMetricNumber(v, fmt)
    : formatMetricValue(v, fmt, unit);
}

export function splitMetricValue(
  v: number,
  fmt: MetricFormat,
  unit?: string | null,
): { number: string; unit: string } {
  const number = formatMetricNumber(v, fmt);
  if (fmt === "percent") return { number, unit: "%" };
  if (fmt === "currency") return { number, unit: "" };
  if (isDurationUnit(unit)) return { number: formatHoursDuration(v), unit: "" };
  return { number, unit: unit ?? "" };
}

export function metricDisplayUnit(
  fmt: MetricFormat,
  unit?: string | null,
): string | undefined {
  if (fmt === "currency" || fmt === "percent") return undefined;
  if (isDurationUnit(unit)) return undefined;
  return unit ?? undefined;
}

export const MULTIPLE_THRESHOLD = 2;

export function formatMultiple(ratio: number): string {
  const rounded = ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10;
  return `${rounded}×`;
}

export function formatPp(diff: number, decimals = 1): string {
  const sign = diff > 0 ? "+" : diff < 0 ? "-" : "";
  return `${sign}${Math.abs(diff).toFixed(decimals)} pp`;
}

export function formatDate(iso: string, pattern = "d MMM"): string {
  return format(parseISO(iso), pattern, { locale: enUS });
}

export function formatUtcInstant(iso: string, pattern = "d MMM"): string {
  return formatDate(withZone(iso), pattern);
}

export function formatUtcAge(iso: string, now = new Date()): string {
  return formatDistance(parseISO(withZone(iso)), now, {
    addSuffix: true,
    locale: enUS,
  });
}

// WORKAROUND: parseISO reads a zone-less date-time as local time; the identity journal serializes UTC without a zone.
function withZone(iso: string): string {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) ? iso : `${iso}Z`;
}

// WORKAROUND: parseISO reads a zone-less date-time as local time, so dropping the zone renders the UTC digits unshifted.
export function formatUtcClock(iso: string, pattern = "d MMM"): string {
  return formatDate(iso.replace(" ", "T").replace(/Z$/i, ""), pattern);
}

function trimTrailingZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function formatAxisTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${trimTrailingZero((v / 1_000_000).toFixed(1))}M`;
  if (abs >= 10_000) {
    const k = Math.round(v / 1000);
    if (Math.abs(k) >= 1000) return `${trimTrailingZero((k / 1000).toFixed(1))}M`;
    return `${k}k`;
  }
  return trimTrailingZero((Math.round(v * 10) / 10).toFixed(1));
}
