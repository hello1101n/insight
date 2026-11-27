import { describe, expect, it } from "vitest";

import type { RunOptions, Widget } from "@/api/custom-client";

import { previousOptions, selectedRange } from "./board-range";

const OFFERED = ["PDC", "P30D", "P1Y"];

describe("selectedRange", () => {
  it("has no window at all for a board that offers none", () => {
    expect(selectedRange(undefined, undefined, "P30D")).toBeUndefined();
    expect(selectedRange([], "P30D", "P30D")).toBeUndefined();
  });

  it("opens on the window the URL names", () => {
    expect(selectedRange(OFFERED, "P30D", "PDC")).toBe("PDC");
  });

  it("opens on the board's default when the URL names none", () => {
    expect(selectedRange(OFFERED, "P30D", undefined)).toBe("P30D");
  });

  it("opens on the first window offered when there is no usable default", () => {
    expect(selectedRange(OFFERED, undefined, undefined)).toBe("PDC");
    expect(selectedRange(OFFERED, "PQC", undefined)).toBe("PDC");
  });

  it("does not open on a preset the board never offered", () => {
    expect(selectedRange(OFFERED, "P30D", "PQC")).toBe("P30D");
  });

  it("opens on a custom interval whether or not the board listed one", () => {
    expect(selectedRange(OFFERED, "P30D", "2026-08-01/2026-09-01")).toBe(
      "2026-08-01/2026-09-01",
    );
  });

  it("ignores a token the server would refuse", () => {
    expect(selectedRange(OFFERED, "P30D", "2026-09-02/2026-09-01")).toBe(
      "P30D",
    );
  });
});

describe("previousOptions", () => {
  const COMPARED: Widget = {
    type: "stat",
    metric: "m",
    value: "n",
    compare: {},
  };
  const PLAIN: Widget = { type: "stat", metric: "m", value: "n" };
  const LINE: Widget = { type: "line", metric: "m", x: "bucket", y: "n" };

  it.each<[string, Widget, RunOptions | undefined, RunOptions | undefined]>([
    [
      "a compared stat over a preset",
      COMPARED,
      { range: "P30D", bucket: false },
      { range: "P30D", bucket: false, previous: true },
    ],
    [
      "a compared stat over an interval",
      COMPARED,
      { range: "2026-10-01/2026-10-15", bucket: false },
      { range: "2026-10-01/2026-10-15", bucket: false, previous: true },
    ],
    ["a compared stat over all time", COMPARED, { range: "inf" }, undefined],
    ["a compared stat with no window", COMPARED, undefined, undefined],
    ["a stat that does not compare", PLAIN, { range: "P30D" }, undefined],
    ["a widget that is not a stat", LINE, { range: "P30D" }, undefined],
  ])("for %s", (_, widget, options, expected) => {
    expect(previousOptions(widget, options)).toEqual(expected);
  });
});
