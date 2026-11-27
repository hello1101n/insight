import type { MetricBucket } from "@/api/metric-results-client";
import { forEntity, type NormalizedMetricResult } from "@/lib/metrics/collection";

export interface BucketBreakdownRow {
  date: string;
  total: number;
  contributors: string[];
}

export function bucketBreakdown(
  key: string,
  byKey: Map<string, NormalizedMetricResult>,
  members: readonly { person_id: string; name: string }[],
): BucketBreakdownRow[] {
  const result = byKey.get(key);
  if (!result) return [];

  const nameOf = new Map(members.map((m) => [m.person_id, m.name]));
  const buckets = new Map<string, { total: number; contributors: Set<string> }>();
  for (const member of members) {
    for (const s of forEntity(result, member.person_id).series) {
      for (const p of s.points) {
        const bucket = buckets.get(p.bucket_start) ?? {
          total: 0,
          contributors: new Set<string>(),
        };
        const value = p.value ?? 0;
        bucket.total += value;
        if (value > 0) bucket.contributors.add(member.person_id);
        buckets.set(p.bucket_start, bucket);
      }
    }
  }

  return [...buckets.entries()]
    .map(([date, bucket]) => ({
      date,
      total: bucket.total,
      contributors: [...bucket.contributors]
        .map((id) => nameOf.get(id) ?? id)
        .sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function bucketRange(
  bucketStart: string,
  bucket: MetricBucket
): { from: string; to: string } {
  const start = new Date(`${bucketStart}T00:00:00Z`);
  if (Number.isNaN(start.getTime()))
    return { from: bucketStart, to: bucketStart };

  const end = new Date(start);
  if (bucket === "week") end.setUTCDate(end.getUTCDate() + 6);
  else if (bucket === "month") {
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
  }
  return { from: bucketStart, to: end.toISOString().slice(0, 10) };
}
