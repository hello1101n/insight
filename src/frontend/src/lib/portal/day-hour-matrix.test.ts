import { describe, expect, it } from "vitest";

import { mondayFirstWeekday } from "./day-hour-matrix";

describe("mondayFirstWeekday", () => {
  it.each([
    ["2026-07-20", 0],
    ["2026-07-23", 3],
    ["2026-07-26", 6],
  ])("starts the week on Monday: %s is day %i", (day, weekday) => {
    expect(
      mondayFirstWeekday(new Date(`${day}T00:00:00Z`)),
      `should index ${day}`
    ).toBe(weekday);
  });
});
