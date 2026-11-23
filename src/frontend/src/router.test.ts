import { describe, expect, it } from "vitest";

import { router } from "./router";

describe("router", () => {
  it("basepath follows the document base", () => {
    expect(router.basepath).toBe("/");
  });
});
