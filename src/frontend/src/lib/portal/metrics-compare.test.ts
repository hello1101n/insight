import { describe, expect, it } from "vitest";

import {
  compareWithBest,
  compareWithMedian,
  formatDelta,
} from "./metrics-compare";

const COUNT = { direction: "higher_is_better", format: "integer", unit: null } as const;
const HOURS_LOWER = { direction: "lower_is_better", format: "decimal", unit: "h" } as const;

describe("compareWithBest", () => {
  it("marks the bigger value best when higher is better, and measures the other from it", () => {
    expect(
      compareWithBest([80, 90], { direction: "higher_is_better", format: "percent", unit: null }),
    ).toEqual([
      { best: false, delta: -10 },
      { best: true, delta: null },
    ]);
  });

  it("marks the smaller value best when lower is better, and measures the other from it", () => {
    expect(compareWithBest([12, 9], HOURS_LOWER)).toEqual([
      { best: false, delta: 3 },
      { best: true, delta: null },
    ]);
  });

  it.each([
    ["a neutral metric", [10, 14], { ...COUNT, direction: "neutral" }],
    ["equal values", [5, 5], COUNT],
    ["a missing value", [7, null], COUNT],
    ["no values", [null, null], COUNT],
    ["values that show the same", [10.04, 9.96], COUNT],
    ["durations that show the same minute", [2.001, 2.002], HOURS_LOWER],
  ] as const)("names no best with %s", (_case, values, result) => {
    expect(compareWithBest(values, result)).toEqual([
      { best: false, delta: null },
      { best: false, delta: null },
    ]);
  });
});

describe("compareWithMedian", () => {
  it("measures each value from the group median when higher is better", () => {
    expect(compareWithMedian([40, 24, 12, 0, 18, 24], COUNT)).toEqual({
      median: 21,
      present: 6,
      cells: [
        { atMedian: false, best: true, delta: 19, better: true },
        { atMedian: false, best: false, delta: 3, better: true },
        { atMedian: false, best: false, delta: -9, better: false },
        { atMedian: false, best: false, delta: -21, better: false },
        { atMedian: false, best: false, delta: -3, better: false },
        { atMedian: false, best: false, delta: 3, better: true },
      ],
    });
  });

  it("marks values at the median, and every tie for best, when lower is better", () => {
    expect(compareWithMedian([12, 15, 12, 9, 9, 15], HOURS_LOWER)).toEqual({
      median: 12,
      present: 6,
      cells: [
        { atMedian: true, best: false, delta: null, better: null },
        { atMedian: false, best: false, delta: 3, better: false },
        { atMedian: true, best: false, delta: null, better: null },
        { atMedian: false, best: true, delta: -3, better: true },
        { atMedian: false, best: true, delta: -3, better: true },
        { atMedian: false, best: false, delta: 3, better: false },
      ],
    });
  });

  it("takes the middle value of an odd count", () => {
    expect(compareWithMedian([3, 1, 2], COUNT).median).toBe(2);
  });

  it("counts only the people with a value, and gives a neutral metric no comparison", () => {
    const neutral = { ...COUNT, direction: "neutral" } as const;

    expect(compareWithMedian([10, 8, null, 12, 14, 10], neutral)).toEqual({
      median: 10,
      present: 5,
      cells: Array.from({ length: 6 }, () => ({
        atMedian: false,
        best: false,
        delta: null,
        better: null,
      })),
    });
  });

  it("marks a best value that sits at the median", () => {
    expect(compareWithMedian([5, 3, 5], COUNT).cells).toEqual([
      { atMedian: true, best: true, delta: null, better: null },
      { atMedian: false, best: false, delta: -2, better: false },
      { atMedian: true, best: true, delta: null, better: null },
    ]);
  });

  it("names no best when every value is the same", () => {
    expect(compareWithMedian([4, 4, 4], COUNT).cells.some((cell) => cell.best)).toBe(false);
  });

  it("rounds the median to the precision the cells show", () => {
    expect(compareWithMedian([10, 11, null], COUNT)).toEqual({
      median: 11,
      present: 2,
      cells: [
        { atMedian: false, best: false, delta: -1, better: false },
        { atMedian: true, best: true, delta: null, better: null },
        { atMedian: false, best: false, delta: null, better: null },
      ],
    });
  });

  it("gives no median when nobody has a value", () => {
    expect(compareWithMedian([null, null, null], COUNT)).toMatchObject({
      median: null,
      present: 0,
    });
  });
});

describe("formatDelta", () => {
  it.each([
    ["percentage points for a percent", -10, "percent", null, "−10 pp"],
    ["the clock form for hours", 3, "decimal", "h", "+3 h 00 min"],
    ["the clock form for less than an hour", -0.5, "decimal", "h", "−0 h 30 min"],
    ["the unit after the number", 109, "integer", "lines", "+109 lines"],
    ["a bare number with no unit", -40, "integer", null, "−40"],
    ["one decimal for a decimal", 2.5, "decimal", "commits", "+2.5 commits"],
    ["the currency form for a currency", 1234, "currency", "USD", "+$1,234"],
  ] as const)("writes %s", (_case, delta, format, unit, text) => {
    expect(formatDelta(delta, { format, unit })).toBe(text);
  });
});
