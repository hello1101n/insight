import { describe, expect, it } from "vitest";

import { chartColor } from "@/lib/chart-palette";
import { seriesColors } from "@/lib/series-colors";

describe("seriesColors", () => {
  it("is deterministic regardless of duplicate seed inputs", () => {
    expect(seriesColors(["cursor", "claude_code", "cursor"])).toEqual(
      seriesColors(["claude_code", "cursor"])
    );
  });

  it("returns one color per unique seed", () => {
    expect(
      Object.keys(seriesColors(["cursor", "cursor", "codex"])).sort()
    ).toEqual(["codex", "cursor"]);
  });

  it("gives known tools their brand token", () => {
    const palette = seriesColors(["slack", "m365", "zoom", "zulip_proxy"]);
    expect(palette.slack).toBe("var(--brand-slack)");
    expect(palette.m365).toBe("var(--brand-m365)");
    expect(palette.zoom).toBe("var(--brand-zoom)");
    expect(palette.zulip_proxy).toBe("var(--brand-zulip)");
  });

  it("assigns palette colours to unknown seeds in sorted order", () => {
    const palette = seriesColors(["beta", "alpha"]);
    expect(palette.alpha).toBe(chartColor(0));
    expect(palette.beta).toBe(chartColor(1));
  });

  it("does not skip chart slots for brand-mapped seeds", () => {
    const palette = seriesColors(["slack", "unknown_tool"]);
    expect(palette.slack).toBe("var(--brand-slack)");
    expect(palette.unknown_tool).toBe(chartColor(0));
  });

  it("cycles the palette past its tenth colour", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    const palette = seriesColors(seeds);
    expect(palette.j).toBe(chartColor(9));
    expect(palette.k).toBe(chartColor(0));
  });

  it("treats prototype-member seeds as unknown, never as brand colors", () => {
    const palette = seriesColors(["__proto__", "constructor"]);
    expect(palette["__proto__"]).toBe(chartColor(0));
    expect(palette["constructor"]).toBe(chartColor(1));
  });
});
