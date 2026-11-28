import { describe, expect, it } from "vitest";

import type { NormalizedMetricResult } from "@/lib/metrics/collection";

import {
  formatPeriodRange,
  resolveChangeDate,
  teamSum,
  teamTimePeriods,
} from "./metrics-team-time";

const TODAY = new Date(2026, 10, 28);

function result(
  values: Array<[string, number | null]>,
  over: Partial<NormalizedMetricResult> = {},
): NormalizedMetricResult {
  return {
    metric_key: "git.prs_merged",
    label: "PRs merged",
    unit: null,
    computation: "sum",
    format: "integer",
    direction: "neutral",
    period: {
      view: "period",
      values: values.map(([entity_id, value]) => ({ entity_id, value })),
    },
    ...over,
  } as NormalizedMetricResult;
}

describe("teamTimePeriods", () => {
  it.each([
    [1, { from: "2026-10-15", to: "2026-10-21" }, { from: "2026-10-08", to: "2026-10-14" }],
    [2, { from: "2026-10-15", to: "2026-10-28" }, { from: "2026-10-01", to: "2026-10-14" }],
    [4, { from: "2026-10-15", to: "2026-11-11" }, { from: "2026-09-17", to: "2026-10-14" }],
  ] as const)(
    "starts After on the change date and ends Before the day before, %i week(s) each",
    (weeks, after, before) => {
      expect(teamTimePeriods("2026-10-15", weeks)).toEqual({ after, before });
    },
  );
});

describe("resolveChangeDate", () => {
  it("opens on today minus the window when the link names no date", () => {
    expect(resolveChangeDate(undefined, 2, TODAY)).toBe("2026-11-14");
    expect(resolveChangeDate(undefined, 4, TODAY)).toBe("2026-10-31");
  });

  it("keeps a change date whose After period is over", () => {
    expect(resolveChangeDate("2026-10-15", 2, TODAY)).toBe("2026-10-15");
  });

  it("moves a change date back until its After period is over", () => {
    expect(resolveChangeDate("2026-11-20", 2, TODAY)).toBe("2026-11-14");
  });
});

describe("formatPeriodRange", () => {
  it.each([
    ["a range in one month", { from: "2026-10-15", to: "2026-10-28" }, "15–28 Oct"],
    ["a range over two months", { from: "2026-10-28", to: "2026-11-10" }, "28 Oct – 10 Nov"],
    ["a range over two years", { from: "2026-12-28", to: "2027-01-10" }, "28 Dec 2026 – 10 Jan 2027"],
  ])("writes %s", (_case, range, text) => {
    expect(formatPeriodRange(range)).toBe(text);
  });
});

describe("teamSum", () => {
  const TEAM = ["a", "b", "c"];

  it("adds the period values of the team's people", () => {
    expect(teamSum(result([["a", 40], ["b", 30], ["x", 1000]]), TEAM)).toBe(70);
  });

  it("adds nothing for a person with no value", () => {
    expect(teamSum(result([["a", 40], ["b", null]]), TEAM)).toBe(40);
  });

  it("has no value when nobody in the team has one", () => {
    expect(teamSum(result([["a", null], ["x", 5]]), TEAM)).toBeNull();
  });

  it.each(["ratio", "median", "percentile", "stddev", "distinct_count"] as const)(
    "has no team value for a %s metric",
    (computation) => {
      expect(teamSum(result([["a", 40], ["b", 30]], { computation }), TEAM)).toBeNull();
    },
  );
});
