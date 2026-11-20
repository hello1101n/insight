import { describe, expect, it } from "vitest";

import { CHART_PALETTE, chartColor } from "@/lib/chart-palette";

describe("chart palette", () => {
  it("starts on the kit's blue, not its red", () => {
    expect(chartColor(0)).toBe("var(--chart-5)");
  });

  it("names each of the twelve defined tokens once", () => {
    const tokens = CHART_PALETTE.map(
      (color) => /^var\(--chart-(\d+)\)$/.exec(color)?.[1]
    );

    expect(tokens.map(Number).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("repeats from the first colour after the twelfth", () => {
    expect(chartColor(12)).toBe(chartColor(0));
  });
});
