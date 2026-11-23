import type { MetricBucket } from "@/api/metric-results-client";
import type { SectionTrendPoint } from "@/components/portal/section-trend";
import {
  forEntity,
  MAX_PROJECTED_ROWS,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

const DAY_MS = 86_400_000;

const BUCKETS: readonly MetricBucket[] = ["day", "week", "month"];

export function pickTrendBucket(
  members: number,
  range: { from: string; to: string },
): MetricBucket | null {
  const rowsPerBucket = Math.max(1, members);
  const maxBuckets = Math.floor(MAX_PROJECTED_ROWS / rowsPerBucket) - 1;
  if (maxBuckets < 1) return null;

  return BUCKETS.find((bucket) => bucketCount(range, bucket) <= maxBuckets) ?? null;
}

function bucketCount(range: { from: string; to: string }, bucket: MetricBucket): number {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 1;

  switch (bucket) {
    case "day":
      return Math.round((to - from) / DAY_MS) + 1;
    case "week":
      return Math.round((mondayOf(to) - mondayOf(from)) / (DAY_MS * 7)) + 1;
    case "month":
      return monthIndex(to) - monthIndex(from) + 1;
  }
}

function mondayOf(timestamp: number): number {
  const weekday = new Date(timestamp).getUTCDay();
  return timestamp - ((weekday + 6) % 7) * DAY_MS;
}

function monthIndex(timestamp: number): number {
  const date = new Date(timestamp);
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

export function buildActiveContributorData(
  key: string,
  byKey: Map<string, NormalizedMetricResult>,
  memberIds: readonly string[],
): SectionTrendPoint[] {
  const result = byKey.get(key);
  if (!result) return [];

  const contributorsByDate = new Map<string, Set<string>>();
  for (const id of memberIds) {
    for (const s of forEntity(result, id).series) {
      for (const p of s.points) {
        const contributors =
          contributorsByDate.get(p.bucket_start) ?? new Set<string>();
        if ((p.value ?? 0) > 0) contributors.add(id);
        contributorsByDate.set(p.bucket_start, contributors);
      }
    }
  }

  return [...contributorsByDate.entries()]
    .map(([date, contributors]) => ({ date, active: contributors.size }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function buildTrendData(
  keys: readonly string[],
  byKey: Map<string, NormalizedMetricResult>,
  memberIds: readonly string[],
): SectionTrendPoint[] {
  const byDate = new Map<string, SectionTrendPoint>();
  for (const key of keys) {
    const r = byKey.get(key);
    if (!r) continue;
    for (const id of memberIds) {
      for (const s of forEntity(r, id).series) {
        for (const p of s.points) {
          const row = byDate.get(p.bucket_start) ?? { date: p.bucket_start };
          row[key] = ((row[key] as number | undefined) ?? 0) + (p.value ?? 0);
          byDate.set(p.bucket_start, row);
        }
      }
    }
  }
  return [...byDate.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );
}

export function buildMedianTrendData(
  key: string,
  byKey: Map<string, NormalizedMetricResult>,
  memberIds: readonly string[],
): SectionTrendPoint[] {
  const r = byKey.get(key);
  if (!r) return [];
  const valuesByDate = new Map<string, number[]>();
  for (const id of memberIds) {
    for (const s of forEntity(r, id).series) {
      for (const p of s.points) {
        if (p.value == null) continue;
        const values = valuesByDate.get(p.bucket_start) ?? [];
        values.push(p.value);
        valuesByDate.set(p.bucket_start, values);
      }
    }
  }
  return [...valuesByDate.entries()]
    .map(([date, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 1
          ? sorted[mid]!
          : (sorted[mid - 1]! + sorted[mid]!) / 2;
      return { date, [key]: median } satisfies SectionTrendPoint;
    })
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}
