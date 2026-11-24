import { describe, expect, it } from "vitest";

import {
  NO_METRIC_VALUE,
  formatHoursDuration,
  formatMetricFigure,
  formatMetricNumber,
  formatMetricValue,
  formatPp,
  formatUtcAge,
  formatUtcClock,
  formatUtcInstant,
  formatClockDuration,
  isClockDuration,
  metricDisplayUnit,
  roundMetricValue,
  splitMetricValue,
} from "@/lib/format";

describe("formatMetricNumber / formatMetricValue / metricDisplayUnit", () => {
  it("formats currency without fraction digits", () => {
    expect(formatMetricNumber(1234, "currency")).toBe("$1,234");
    expect(formatMetricValue(1234, "currency", "USD")).toBe("$1,234");
  });

  it("rounds decimal format to one decimal and integers to whole", () => {
    expect(formatMetricNumber(1.24, "decimal")).toBe("1.2");
    expect(formatMetricNumber(1234.6, "integer")).toBe("1,235");
  });

  it("rounds numeric values with the metric's display precision", () => {
    expect(roundMetricValue(1.24, "decimal")).toBe(1.2);
    expect(roundMetricValue(1234.6, "integer")).toBe(1235);
  });

  it("suffixes percent and unit forms", () => {
    expect(formatMetricValue(42.4, "percent")).toBe("42%");
    expect(formatMetricValue(5, "integer", "h")).toBe("5 h");
    expect(formatMetricValue(5, "integer", null)).toBe("5");
  });

  it("renders no-data as an em-dash, never a fabricated zero", () => {
    for (const empty of [null, undefined, NaN, Infinity, -Infinity] as const) {
      expect(formatMetricNumber(empty, "integer")).toBe(NO_METRIC_VALUE);
      expect(formatMetricValue(empty, "currency", "USD")).toBe(NO_METRIC_VALUE);
      expect(formatMetricValue(empty, "percent")).toBe(NO_METRIC_VALUE);
      expect(formatMetricValue(empty, "integer", "h")).toBe(NO_METRIC_VALUE);
    }
    expect(formatMetricNumber(0, "integer")).toBe("0");
    expect(formatMetricValue(0, "percent")).toBe("0%");
  });

  it("renders hours as clock time, carrying the unit in the value", () => {
    expect(formatHoursDuration(1.25)).toBe("1 h 15 min");
    expect(formatHoursDuration(0.75)).toBe("45 min");
    expect(formatHoursDuration(3)).toBe("3 h");
    expect(formatHoursDuration(0)).toBe("0 min");
    expect(formatHoursDuration(-1.5)).toBe("-1 h 30 min");
    expect(formatHoursDuration(1.9999)).toBe("2 h");
    expect(formatHoursDuration(1234.6)).toBe("1,235 h");
    expect(formatMetricValue(1.25, "decimal", "h")).toBe("1 h 15 min");
    expect(formatMetricFigure(1.25, "decimal", "h")).toBe("1 h 15 min");
    expect(metricDisplayUnit("decimal", "h")).toBeUndefined();
    expect(splitMetricValue(1.25, "decimal", "h")).toEqual({
      number: "1 h 15 min",
      unit: "",
    });
  });

  it("formatMetricFigure leaves the unit to the side element when one renders", () => {
    expect(formatMetricFigure(5, "integer", "commits")).toBe("5");
    expect(formatMetricFigure(42.4, "percent", null)).toBe("42%");
    expect(formatMetricFigure(1234, "currency", "USD")).toBe("$1,234");
    expect(formatMetricFigure(null, "integer", "commits")).toBe(NO_METRIC_VALUE);
  });

  it("hides the side unit when the number already carries it", () => {
    expect(metricDisplayUnit("currency", "USD")).toBeUndefined();
    expect(metricDisplayUnit("percent", "%")).toBeUndefined();
    expect(metricDisplayUnit("integer", "commits")).toBe("commits");
    expect(metricDisplayUnit("integer", null)).toBeUndefined();
  });
});

describe("small formatters", () => {
  it("formatPp signs the difference and always shows points", () => {
    expect(formatPp(2.5)).toBe("+2.5 pp");
    expect(formatPp(-2.5)).toBe("-2.5 pp");
    expect(formatPp(0)).toBe("0.0 pp");
  });

  it("formatUtcClock shows the instant's own UTC clock, not the reader's", () => {
    expect(formatUtcClock("2026-08-16 16:46:32.000", "d MMM HH:mm")).toBe("16 Aug 16:46");
    expect(formatUtcClock("2026-08-16T16:46:32Z", "d MMM HH:mm")).toBe("16 Aug 16:46");
  });

  it("formatUtcInstant reads a zone-less timestamp as UTC, not local", () => {
    expect(formatUtcInstant("2026-08-01T10:15:00.000000", "d MMM yyyy, HH:mm")).toBe(
      formatUtcInstant("2026-08-01T10:15:00Z", "d MMM yyyy, HH:mm"),
    );
    expect(
      formatUtcInstant("2026-08-01T10:15:00+02:00", "HH:mm"),
    ).toBe(formatUtcInstant("2026-08-01T08:15:00Z", "HH:mm"));
  });

  it("formatUtcAge reads a zone-less timestamp as UTC too", () => {
    const now = new Date("2026-08-08T10:15:00Z");

    expect(formatUtcAge("2026-08-01T10:15:00.000000", now)).toBe("7 days ago");
    expect(formatUtcAge("2026-08-01T10:15:00Z", now)).toBe("7 days ago");
  });
});

describe("formatClockDuration", () => {
  it.each([
    [0.7833, "0 h 47 min"],
    [46.0667, "46 h 04 min"],
    [9.4833, "9 h 29 min"],
    [0, "0 h 00 min"],
    [1.9999, "2 h 00 min"],
    [1234.5, "1,234 h 30 min"],
    [-1.5, "-1 h 30 min"],
    [-0.001, "0 h 00 min"],
  ])("writes %s hours as %s", (hours, text) => {
    expect(formatClockDuration(hours)).toBe(text);
  });
});

describe("isClockDuration", () => {
  it.each([
    ["decimal", "h", true],
    ["integer", "h", true],
    ["percent", "h", false],
    ["currency", "h", false],
    ["decimal", "d", false],
    ["decimal", null, false],
  ] as const)("is %s with unit %s: %s", (format, unit, expected) => {
    expect(isClockDuration(format, unit)).toBe(expected);
  });
});
