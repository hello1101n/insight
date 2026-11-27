import { describe, expect, it } from "vitest";

import type { Widget } from "@/api/custom-client";

import { drawsBucket } from "./draws-bucket";

describe("drawsBucket", () => {
  it("is true for a series drawing the injected column on either axis", () => {
    expect(
      drawsBucket({ type: "line", metric: "m", x: "bucket", y: "opened" }),
    ).toBe(true);
    expect(
      drawsBucket({ type: "area", metric: "m", x: "day", y: "bucket" }),
    ).toBe(true);
  });

  it("is true for a bar stacked by it", () => {
    expect(
      drawsBucket({
        type: "bar",
        metric: "m",
        x: "author",
        y: "n",
        series: "bucket",
      }),
    ).toBe(true);
  });

  it("is true for a table that lists it among its columns", () => {
    expect(
      drawsBucket({ type: "table", metric: "m", columns: ["bucket", "n"] }),
    ).toBe(true);
  });

  it("is true for a stat or a pie that names it", () => {
    expect(drawsBucket({ type: "stat", metric: "m", value: "bucket" })).toBe(
      true,
    );
    expect(
      drawsBucket({ type: "pie", metric: "m", label: "bucket", value: "n" }),
    ).toBe(true);
  });

  it("is false for a categorical widget that never reads it", () => {
    expect(
      drawsBucket({ type: "pie", metric: "m", label: "repo", value: "n" }),
    ).toBe(false);
    expect(
      drawsBucket({ type: "bar", metric: "m", x: "author", y: "n" }),
    ).toBe(false);
    expect(
      drawsBucket({ type: "table", metric: "m", columns: ["author", "n"] }),
    ).toBe(false);
    expect(drawsBucket({ type: "stat", metric: "m", value: "n" })).toBe(false);
  });
});

describe("drawsBucket for the newer widget types", () => {
  it.each<[string, Widget, boolean]>([
    [
      "a line by the bucket series",
      { type: "line", metric: "m", x: "team", y: "n", series: "bucket" },
      true,
    ],
    [
      "a calendar heatmap",
      { type: "heatmap", metric: "m", x: "bucket", value: "n" },
      true,
    ],
    [
      "a heatmap over two categories",
      { type: "heatmap", metric: "m", x: "team", y: "repo", value: "n" },
      false,
    ],
    [
      "a funnel with the bucket among its stages",
      { type: "funnel", metric: "m", stages: ["opened", "bucket"] },
      true,
    ],
    [
      "a funnel of counts",
      { type: "funnel", metric: "m", stages: ["opened", "merged"] },
      false,
    ],
    [
      "a treemap grouped by the bucket",
      {
        type: "treemap",
        metric: "m",
        label: "repo",
        value: "n",
        group: "bucket",
      },
      true,
    ],
    [
      "a scatter named by the bucket",
      {
        type: "scatter",
        metric: "m",
        x: "size",
        y: "hours",
        label: "bucket",
      },
      true,
    ],
    [
      "a scatter of two measures",
      { type: "scatter", metric: "m", x: "size", y: "hours" },
      false,
    ],
  ])("answers for %s", (_, widget, expected) => {
    expect(drawsBucket(widget)).toBe(expected);
  });
});
