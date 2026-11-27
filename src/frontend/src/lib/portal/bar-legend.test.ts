import { describe, expect, it } from "vitest";

import type { BarRow } from "@/lib/portal/bar-rows";

import { segmentLegend } from "./bar-legend";

function row(key: string, segments: BarRow["segments"]): BarRow {
  const value = (segments ?? []).reduce((sum, s) => sum + s.value, 0);
  return { key, label: key, value, pct: 0, segments };
}

describe("segmentLegend", () => {
  it("the legend counts segments of rows beyond the collapsed list, biggest first", () => {
    const shown = Array.from({ length: 12 }, (_, i) =>
      row(`repo-${i}`, [{ seed: "github", label: "GitHub", value: 1 }])
    );
    const pastTheFold = row("repo-12", [
      { seed: "gitlab", label: "GitLab", value: 20 },
    ]);

    const { colors, legend } = segmentLegend([...shown, pastTheFold]);

    expect(legend.map(({ seed, label }) => ({ seed, label }))).toEqual([
      { seed: "gitlab", label: "GitLab" },
      { seed: "github", label: "GitHub" },
    ]);
    expect(legend.map((entry) => entry.color)).toEqual([
      colors.gitlab,
      colors.github,
    ]);
  });
});
