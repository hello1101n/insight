import { describe, expect, it } from "vitest";

import type { DurationUnit } from "@/api/custom-client";

import { durationText } from "./duration";

describe("durationText", () => {
  it.each<[number, DurationUnit, string]>([
    [52, "h", "2d 4h"],
    [48, "h", "2d"],
    [200, "min", "3h 20m"],
    [45, "s", "45s"],
    [120, "ms", "120ms"],
    [1.5, "d", "1d 12h"],
    [90, "s", "1m 30s"],
    [45.4, "s", "45s"],
    [59.6, "s", "1m"],
    [23.996, "h", "1d"],
    [999.6, "ms", "1s"],
    [0.4, "ms", "0ms"],
    [0, "h", "0h"],
    [0, "min", "0m"],
    [-52, "h", "-2d 4h"],
    [3_600_000, "ms", "1h"],
    [86_400, "s", "1d"],
  ])("writes %d %s as %s", (value, unit, text) => {
    expect(durationText(value, unit)).toBe(text);
  });
});
