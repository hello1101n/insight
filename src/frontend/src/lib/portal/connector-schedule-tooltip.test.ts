import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  ConnectorSchedule,
  ScheduleRequestState,
} from "@/api/connector-health-client";
import { scheduleTooltipLines } from "./connector-schedule-tooltip";

const schedule: ConnectorSchedule = {
  connector: "example-tracker",
  source_id: "main",
  revision: 3,
  status: "pending",
  pending_reason: "different_schedule",
  next_reconcile_at: "2026-01-16T00:15:00Z",
  requested: {
    crons: ["0 6 * * *"],
    updated_by: "00000000-0000-4000-8000-000000000001",
    updated_at: "2026-01-14T13:00:30+01:00",
  },
  live: {
    crons: ["0 3 * * *", "0 15 * * *"],
    observed_at: "2026-01-15T11:00:30Z",
    timezone: "UTC",
    origin: "api",
    suspended: false,
  },
  inherited: { crons: ["0 2 * * *", "0 14 * * *"], origin: "descriptor" },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

it.each([
  ["annotation", "Runs the schedule set at deployment in instance settings."],
  ["descriptor", "Runs the connector's default schedule."],
  ["default", "Runs the default schedule: every day at 00:00 UTC."],
  ["api", "Runs the schedule set through the API."],
] as const)(
  "names the plain deployment source for %s and every cron",
  (origin, source) => {
    const crons =
      origin === "default" ? ["0 0 * * *"] : schedule.inherited!.crons;
    expect(
      scheduleTooltipLines({
        ...schedule,
        status: "inherited",
        requested: null,
        inherited: { crons, origin },
      })
    ).toEqual([source, ...crons.map((cron) => `${cron} UTC`)]);
  }
);

it("dates an applied schedule and lists the overridden deployment schedule", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      status: "applied",
      pending_reason: null,
      next_reconcile_at: null,
      requested: { ...schedule.requested!, crons: schedule.live!.crons },
    })
  ).toEqual([
    "Saved by another admin on 14 Jan at 12:00 UTC.",
    "Running as of 11:00 UTC.",
    "0 3 * * * UTC",
    "0 15 * * * UTC",
    "Overrides the connector's default schedule.",
    "0 2 * * * UTC",
    "0 14 * * * UTC",
  ]);
});

it("omits a next-check hint when the schedule is applied and the deployment schedule is unknown", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      status: "applied",
      pending_reason: null,
      next_reconcile_at: null,
      requested: { ...schedule.requested!, crons: schedule.live!.crons },
      inherited: null,
    })
  ).toEqual([
    "Saved by another admin on 14 Jan at 12:00 UTC.",
    "Running as of 11:00 UTC.",
    "0 3 * * * UTC",
    "0 15 * * * UTC",
  ]);
});

it("gives the pending start estimate and lists each running cron once", () => {
  expect(scheduleTooltipLines(schedule)).toEqual([
    "Saved by another admin on 14 Jan at 12:00 UTC.",
    "The sync job runs a different schedule.",
    "Starts by 16 Jan at 00:15 UTC.",
    "Running as of 11:00 UTC.",
    "0 3 * * * UTC",
    "0 15 * * * UTC",
  ]);
});

it("lists the full reset target when only one cron is shared", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: { crons: ["0 3 * * *", "0 14 * * *"], origin: "annotation" },
    })
  ).toEqual([
    "The sync job runs a different schedule.",
    "Starts by 16 Jan at 00:15 UTC.",
    "Returns to the schedule set at deployment in instance settings.",
    "0 3 * * * UTC",
    "0 14 * * * UTC",
    "Running as of 11:00 UTC.",
    "0 3 * * * UTC",
    "0 15 * * * UTC",
  ]);
});

it("lists the reset target when it is a strict subset of the running crons", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: { crons: ["0 3 * * *"], origin: "descriptor" },
    })
  ).toEqual([
    "The sync job runs a different schedule.",
    "Starts by 16 Jan at 00:15 UTC.",
    "Returns to the connector's default schedule.",
    "0 3 * * * UTC",
    "Running as of 11:00 UTC.",
    "0 3 * * * UTC",
    "0 15 * * * UTC",
  ]);
});

it("explains a pending reset when the deployment schedule and next check are unknown", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: null,
      pending_reason: "awaiting_reconcile",
      next_reconcile_at: null,
    })
  ).toEqual([
    "The deployment schedule is shown after the next check.",
    "Running as of 11:00 UTC.",
    "0 3 * * * UTC",
    "0 15 * * * UTC",
  ]);
});

it("gives one availability sentence for a pending reset with a known next check", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: null,
      pending_reason: "awaiting_reconcile",
    })
  ).toEqual([
    "The deployment schedule is shown after 16 Jan at 00:15 UTC.",
    "Running as of 11:00 UTC.",
    "0 3 * * * UTC",
    "0 15 * * * UTC",
  ]);
});

it("explains why an instance without a sync job is not scheduled", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      requested: null,
      live: null,
      inherited: null,
      pending_reason: "no_cronworkflow",
      next_reconcile_at: null,
    })
  ).toEqual([
    "This instance has no sync schedule yet.",
    "Takes effect after the next check.",
    "No sync job runs until then.",
  ]);
});

it("explains that the schedule has not been loaded when the response is missing", () => {
  expect(scheduleTooltipLines(undefined)).toEqual([
    "The schedule has not been loaded yet.",
  ]);
});

it.each([
  ["pending", "Pending"],
  ["applied", "Set by admin"],
  ["inherited", "Default"],
  ["paused", "Paused"],
] as const)(
  "names the summary's %s status while schedule details load",
  (status, label) => {
    const request: ScheduleRequestState = {
      crons: ["0 6 * * *"],
      revision: 3,
      last_observation: { status, observed_at: "2026-01-15T12:00:00Z" },
    };
    expect(scheduleTooltipLines(request)).toEqual([
      `${label}. Schedule details are loading.`,
    ]);
  }
);

it("shows loading while a summary has no schedule observation", () => {
  expect(
    scheduleTooltipLines({ crons: [], revision: 3, last_observation: null })
  ).toEqual(["The schedule has not been loaded yet."]);
});

it.each(["you", "Example Admin", "another admin"])(
  "uses the supplied author wording %s without exposing the person id",
  (person) => {
    const lines = scheduleTooltipLines(schedule, person).join(" ");
    expect(lines).toContain(`Saved by ${person} on`);
    expect(lines).not.toContain(schedule.requested!.updated_by);
  }
);

it("omits the reset target crons when the running UTC set matches in a different order", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: {
        crons: [...schedule.live!.crons].reverse(),
        origin: "annotation",
      },
    })
  ).toEqual([
    "The sync job runs a different schedule.",
    "Starts by 16 Jan at 00:15 UTC.",
    "Returns to the schedule set at deployment in instance settings.",
    "Running as of 11:00 UTC.",
    "0 3 * * * UTC",
    "0 15 * * * UTC",
  ]);
});

it("explains that the live schedule has not been recorded for an applied request", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      status: "applied",
      live: null,
      inherited: null,
    })
  ).toEqual([
    "Saved by another admin on 14 Jan at 12:00 UTC.",
    "The live schedule has not been recorded yet.",
  ]);
});

it("explains when the default schedule is shown if the deployment target is unknown", () => {
  expect(
    scheduleTooltipLines({
      ...schedule,
      status: "inherited",
      requested: null,
      inherited: null,
    })
  ).toEqual(["The deployment schedule is shown after 16 Jan at 00:15 UTC."]);
});
