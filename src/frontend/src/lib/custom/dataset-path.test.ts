import { describe, expect, it } from "vitest";

import { pathSegments } from "./dataset-path";

describe("pathSegments", () => {
  it.each([
    ["a", ["a"]],
    ["stats.lines", ["stats", "lines"]],
    ["a\\.b", ["a.b"]],
    ["outer.a\\.b.inner", ["outer", "a.b", "inner"]],
    ["a\\\\b", ["a\\b"]],
  ])("splits %s the way the service does", (path, expected) => {
    expect(pathSegments(path)).toEqual(expected);
  });
});
