import { describe, expect, it } from "vitest";

import type { MetricResult } from "@/api/metric-results-client";
import { normalizeMetricResults } from "@/lib/metrics/collection";
import {
  TREND_BUCKETS,
  personTrendPoints,
  runningBucketStart,
  trendBucket,
  trendRange,
} from "./person-trend";

const ME = "019e27bc-dec0-7626-81a9-c5524662a6a9";

function withSeries(points: [string, number | null][]) {
  const result = {
    metric_key: "git.commits",
    label: "Commits",
    unit: null,
    format: "integer",
    computation: "sum",
    direction: "higher_is_better",
    views: [
      {
        view: "timeseries",
        bucket: "month",
        series: [
          {
            entity_id: ME,
            dimensions: [],
            points: points.map(([bucket_start, value]) => ({
              bucket_start,
              value,
            })),
          },
        ],
      },
    ],
  } as unknown as MetricResult;
  return normalizeMetricResults([result]).get("git.commits");
}

describe("trendBucket", () => {
  it("draws the line in the unit the reader picked", () => {
    expect(trendBucket("week")).toBe("week");
    expect(trendBucket("month")).toBe("month");
    expect(trendBucket("quarter")).toBe("month");
    expect(trendBucket("year")).toBe("month");
  });
});

describe("runningBucketStart", () => {
  it("finds the first of the month", () => {
    expect(runningBucketStart("2026-03-18", "month")).toBe("2026-03-01");
  });

  it("finds the Monday of the week, including from a Sunday", () => {
    expect(runningBucketStart("2026-03-18", "week")).toBe("2026-03-16");
    expect(runningBucketStart("2026-03-22", "week")).toBe("2026-03-16");
    expect(runningBucketStart("2026-03-16", "week")).toBe("2026-03-16");
  });
});

describe("trendRange", () => {
  it("asks for the finished buckets plus the running one", () => {
    const { from, to } = trendRange("2026-03-18", "month");
    expect(to).toBe("2026-03-18");
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    expect(days).toBeGreaterThan(31 * TREND_BUCKETS);
  });
});

describe("personTrendPoints", () => {
  const running = "2026-03-01";

  it("drops the running bucket", () => {
    const points = personTrendPoints(
      withSeries([
        ["2025-12-01", 10],
        ["2026-01-01", 12],
        ["2026-02-01", 11],
        ["2026-03-01", 1],
      ]),
      ME,
      running
    );
    expect(points).toEqual([10, 12, 11]);
  });

  it("draws nothing below three readings", () => {
    expect(
      personTrendPoints(
        withSeries([
          ["2026-01-01", 10],
          ["2026-02-01", 12],
        ]),
        ME,
        running
      )
    ).toBeNull();
  });

  it("keeps a gap as a gap rather than a zero", () => {
    expect(
      personTrendPoints(
        withSeries([
          ["2025-11-01", 10],
          ["2025-12-01", null],
          ["2026-01-01", 12],
          ["2026-02-01", 11],
        ]),
        ME,
        running
      )
    ).toEqual([10, null, 12, 11]);
  });

  it("counts only real readings towards the minimum", () => {
    expect(
      personTrendPoints(
        withSeries([
          ["2025-11-01", 10],
          ["2025-12-01", null],
          ["2026-01-01", null],
          ["2026-02-01", 11],
        ]),
        ME,
        running
      )
    ).toBeNull();
  });

  it("keeps the most recent window, oldest first", () => {
    const extra = 4;
    const many = Array.from(
      { length: TREND_BUCKETS + extra },
      (_, i): [string, number] => [`${2020 + i}-01-01`, i]
    );
    const points = personTrendPoints(
      withSeries(many),
      ME,
      `${2020 + TREND_BUCKETS + extra}-01-01`
    );
    expect(points).toHaveLength(TREND_BUCKETS);
    expect(points?.[0]).toBe(extra);
    expect(points?.at(-1)).toBe(TREND_BUCKETS + extra - 1);
  });

  it("orders by bucket, not by arrival", () => {
    const points = personTrendPoints(
      withSeries([
        ["2026-02-01", 11],
        ["2025-12-01", 10],
        ["2026-01-01", 12],
      ]),
      ME,
      running
    );
    expect(points).toEqual([10, 12, 11]);
  });

  it("has nothing to draw for a metric that never arrived", () => {
    expect(personTrendPoints(undefined, ME, running)).toBeNull();
  });
});
