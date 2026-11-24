import { describe, expect, it } from "vitest";

import { withoutPagingRepeats } from "./paging";

describe("withoutPagingRepeats", () => {
  it("keeps the first copy of a row a later page repeats, in page order", () => {
    const pages = [
      { id: "a", read: "page 1" },
      { id: "b", read: "page 1" },
      { id: "b", read: "page 2" },
      { id: "c", read: "page 2" },
    ];

    expect(withoutPagingRepeats(pages)).toEqual([
      { id: "a", read: "page 1" },
      { id: "b", read: "page 1" },
      { id: "c", read: "page 2" },
    ]);
  });
});
