import { expect, it } from "vitest";
import {
  relativeScheduleTime,
  scheduleClock,
  scheduleTime,
  shortScheduleTime,
} from "./connector-schedule-time";

const now = new Date("2026-01-15T12:00:00Z");

it.each([
  [0, "just now", "just now"],
  [40, "just now", "just now"],
  [61, "in 1 min", "1 min ago"],
  [71 * 60, "in 1 h", "1 h ago"],
  [131 * 60, "in 2 h", "2 h ago"],
] as const)(
  "rounds %s seconds to the nearest unit in both directions",
  (seconds, future, past) => {
    expect(relativeScheduleTime(new Date(+now + seconds * 1000), now)).toBe(
      future
    );
    expect(relativeScheduleTime(new Date(+now - seconds * 1000), now)).toBe(
      past
    );
  }
);

it("includes a date for other UTC days and omits seconds", () => {
  expect(shortScheduleTime(now, now)).toBe("12:00");
  expect(scheduleTime(now, now)).toBe("12:00 UTC");
  expect(scheduleTime("2026-01-15T23:30:20-02:00", now)).toBe(
    "16 Jan at 01:30 UTC"
  );
  expect(scheduleTime("invalid")).toBe("—");
  expect(relativeScheduleTime("invalid", now)).toBe("—");
});

it.each([
  ["2026-01-15T23:30:00Z", "2026-01-15T12:00:00Z", "23:30"],
  ["2026-01-16T00:30:00Z", "2026-01-15T23:30:00Z", "Fri 00:30"],
  ["2026-01-23T00:30:00Z", "2026-01-15T23:30:00Z", "Fri 00:30"],
  ["2027-01-01T00:30:00Z", "2026-12-31T23:30:00Z", "Fri 00:30"],
])(
  "uses UTC days and weekdays for %s relative to %s",
  (value, reference, expected) => {
    expect(shortScheduleTime(new Date(value), new Date(reference))).toBe(
      expected
    );
  }
);

it.each([
  ["2026-01-15T13:30:00+02:00", "11:30"],
  ["2026-01-15T23:30:00-02:00", "01:30"],
  ["invalid", "—"],
  [null, "—"],
  [undefined, "—"],
])(
  "formats UTC clocks without a browser timezone for %s",
  (value, expected) => {
    expect(scheduleClock(value)).toBe(expected);
  }
);

it.each([
  ["2026-09-12T16:48:00Z", "12 Sep at 16:48 UTC"],
  ["2025-11-12T16:48:00Z", "12 Nov 2025 at 16:48 UTC"],
])("formats the UTC date for %s", (value, expected) => {
  expect(scheduleTime(value, now)).toBe(expected);
});
