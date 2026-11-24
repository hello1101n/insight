import type { DateRange } from "@/api/period-to-date-range";
import type { MetricBucket } from "@/api/metric-results-client";
import type { PeriodValue } from "@/types/insight";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

export const TREND_BUCKETS = 8;

export function trendBucket(period: PeriodValue): MetricBucket {
  return period === "week" ? "week" : "month";
}

const BUCKET_DAYS: Record<MetricBucket, number> = {
  day: 1,
  week: 7,
  month: 31,
};

export function trendRange(today: string, bucket: MetricBucket): DateRange {
  const span = BUCKET_DAYS[bucket] * (TREND_BUCKETS + 1);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - span * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to: today };
}

export function runningBucketStart(
  today: string,
  bucket: MetricBucket
): string {
  if (bucket === "month") return `${today.slice(0, 7)}-01`;
  if (bucket === "week") {
    const d = new Date(`${today}T00:00:00Z`);
    const back = (d.getUTCDay() + 6) % 7;
    return new Date(d.getTime() - back * 86_400_000).toISOString().slice(0, 10);
  }
  return today;
}

const MIN_READINGS = 3;

export function personTrendPoints(
  metric: NormalizedMetricResult | undefined,
  entityId: string,
  runningStart: string
): (number | null)[] | null {
  if (!metric) return null;
  const series = forEntity(metric, entityId).series[0]?.points ?? [];
  const points = series
    .filter((p) => p.bucket_start < runningStart)
    .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start))
    .slice(-TREND_BUCKETS)
    .map((p) => p.value ?? null);
  return points.filter((v) => v != null).length >= MIN_READINGS ? points : null;
}
