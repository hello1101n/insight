import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type {
  ConnectorSchedule,
  ScheduleRequestState,
} from "@/api/connector-health-client";
import { scheduleTooltip } from "./connector-schedule-tooltip";

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

function tooltipText(
  schedule: ConnectorSchedule | ScheduleRequestState | undefined,
  person?: string
): string[] {
  const { status, rows } = scheduleTooltip(schedule, person);
  const rowText = rows.map(
    ({ label, qualifier, crons, zone }) =>
      `${label} · ${qualifier} ${crons.join("; ")} ${zone}`
  );
  return status ? [status, ...rowText] : rowText;
}

const running = "Running · as of 11:00 0 3 * * *; 0 15 * * * UTC";
const pending =
  "The sync job runs a different schedule. Starts by 16 Jan 2026 · 00:15:00 UTC.";

it.each([
  ["annotation", "Runs the schedule set at deployment in instance settings."],
  ["descriptor", "Runs the connector's default schedule."],
  ["default", "Runs the default schedule: every day at 00:00 UTC."],
  ["api", "Runs the schedule set through the API."],
] as const)(
  "names the plain deployment source for %s and every running cron",
  (origin, source) => {
    const crons =
      origin === "default" ? ["0 0 * * *"] : schedule.inherited!.crons;
    expect(
      tooltipText({
        ...schedule,
        status: "inherited",
        requested: null,
        inherited: { crons, origin },
      })
    ).toEqual([source, running]);
  }
);

it("dates an applied schedule and lists the overridden deployment schedule", () => {
  expect(
    tooltipText({
      ...schedule,
      status: "applied",
      pending_reason: null,
      next_reconcile_at: null,
      requested: { ...schedule.requested!, crons: schedule.live!.crons },
    })
  ).toEqual([
    "Saved by another admin on 14 Jan 2026 · 12:00:30 UTC.",
    running,
    "Deployment · connector default 0 2 * * *; 0 14 * * * UTC",
  ]);
});

it("omits a next-check hint when the schedule is applied and the deployment schedule is unknown", () => {
  expect(
    tooltipText({
      ...schedule,
      status: "applied",
      pending_reason: null,
      next_reconcile_at: null,
      requested: { ...schedule.requested!, crons: schedule.live!.crons },
      inherited: null,
    })
  ).toEqual(["Saved by another admin on 14 Jan 2026 · 12:00:30 UTC.", running]);
});

it("gives the pending start estimate and lists each running cron once", () => {
  expect(tooltipText(schedule)).toEqual([
    pending,
    "Target · saved by another admin on 14 Jan 2026 · 12:00:30 0 6 * * * UTC",
    running,
  ]);
});

it("lists the full reset target when only one cron is shared", () => {
  expect(
    tooltipText({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: { crons: ["0 3 * * *", "0 14 * * *"], origin: "annotation" },
    })
  ).toEqual([
    pending,
    "Target · instance settings 0 3 * * *; 0 14 * * * UTC",
    running,
  ]);
});

it("lists the reset target when it is a strict subset of the running crons", () => {
  expect(
    tooltipText({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: { crons: ["0 3 * * *"], origin: "descriptor" },
    })
  ).toEqual([pending, "Target · connector default 0 3 * * * UTC", running]);
});

it("explains a pending reset when the deployment schedule and next check are unknown", () => {
  expect(
    tooltipText({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: null,
      pending_reason: "awaiting_reconcile",
      next_reconcile_at: null,
    })
  ).toEqual([
    "The deployment schedule is shown after the next check.",
    running,
  ]);
});

it("gives one availability sentence for a pending reset with a known next check", () => {
  expect(
    tooltipText({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: null,
      pending_reason: "awaiting_reconcile",
    })
  ).toEqual([
    "The deployment schedule is shown after 16 Jan 2026 · 00:15:00 UTC.",
    running,
  ]);
});

it("explains why an instance without a sync job is not scheduled", () => {
  expect(
    tooltipText({
      ...schedule,
      requested: null,
      live: null,
      inherited: null,
      pending_reason: "no_cronworkflow",
      next_reconcile_at: null,
    })
  ).toEqual([
    "This instance has no sync schedule yet. Takes effect after the next check. No sync job runs until then.",
  ]);
});

it("explains that the schedule has not been loaded when the response is missing", () => {
  expect(tooltipText(undefined)).toEqual([
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
    expect(tooltipText(request)).toEqual([
      `${label}. Schedule details are loading.`,
    ]);
  }
);

it("shows loading while a summary has no schedule observation", () => {
  expect(
    tooltipText({ crons: [], revision: 3, last_observation: null })
  ).toEqual(["The schedule has not been loaded yet."]);
});

it.each(["you", "Example Admin", "another admin"])(
  "uses the supplied author wording %s without exposing the person id",
  (person) => {
    const lines = tooltipText(schedule, person).join(" ");
    expect(lines).toContain(`Target · saved by ${person}`);
    expect(lines).not.toContain(schedule.requested!.updated_by);
  }
);

it("lists the reset target crons when the running UTC set matches in a different order", () => {
  expect(
    tooltipText({
      ...schedule,
      requested: { ...schedule.requested!, crons: [] },
      inherited: {
        crons: [...schedule.live!.crons].reverse(),
        origin: "annotation",
      },
    })
  ).toEqual([
    pending,
    "Target · instance settings 0 15 * * *; 0 3 * * * UTC",
    running,
  ]);
});

it("dates an applied request when the live schedule has not been recorded", () => {
  expect(
    tooltipText({
      ...schedule,
      status: "applied",
      live: null,
      inherited: null,
    })
  ).toEqual([
    "Saved by another admin on 14 Jan 2026 · 12:00:30 UTC. The live schedule has not been recorded yet.",
  ]);
});

it("explains when the default schedule is shown if the deployment target is unknown", () => {
  expect(
    tooltipText({
      ...schedule,
      status: "inherited",
      requested: null,
      inherited: null,
    })
  ).toEqual([
    "The deployment schedule is shown after 16 Jan 2026 · 00:15:00 UTC.",
    running,
  ]);
});
