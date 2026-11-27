import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

import type {
  ConnectorSchedule,
  InheritedSchedule,
} from "@/api/connector-health-client";

import { mocks, pane, read } from "./fixtures";

const requested = read().schedule.requested!;
const live = {
  ...read().schedule.live!,
  crons: ["0 3 * * *", "0 15 * * *"],
  observed_at: "2026-01-15T00:19:00Z",
};
const deployment = {
  crons: ["0 2 * * *"],
  origin: "descriptor",
} satisfies InheritedSchedule;
const running = "Running · as of 00:19 0 3 * * *; 0 15 * * * UTC";
const different = "The sync job runs a different schedule.";
const nextCheck = "2026-01-15T12:15:00Z";

it.each<{
  badge: string;
  name: string;
  schedule?: Partial<ConnectorSchedule>;
  status: string;
  rows: string[];
}>([
  {
    name: "Default",
    badge: "Default",
    schedule: {
      status: "inherited",
      requested: null,
      inherited: { crons: live.crons, origin: "annotation" },
    },
    status: "Runs the schedule set at deployment in instance settings.",
    rows: [running],
  },
  {
    name: "Set by admin",
    badge: "Set by admin",
    schedule: {
      status: "applied",
      requested: { ...requested, crons: live.crons },
      inherited: deployment,
    },
    status: "Saved by you at 12:00 UTC.",
    rows: [running, "Deployment · connector default 0 2 * * * UTC"],
  },
  {
    name: "pending saved schedule",
    badge: "Pending",
    schedule: { pending_reason: "different_schedule" },
    status: `${different} Starts by 12:15 UTC.`,
    rows: ["Target · saved by you at 12:00 0 6 * * * UTC", running],
  },
  {
    name: "pending reset with identical crons",
    badge: "Pending",
    schedule: {
      pending_reason: "different_schedule",
      requested: { ...requested, crons: [] },
      inherited: { crons: [...live.crons].reverse(), origin: "annotation" },
    },
    status: `${different} Starts by 12:15 UTC.`,
    rows: ["Target · instance settings 0 15 * * *; 0 3 * * * UTC", running],
  },
  {
    name: "pending deployment change without a request",
    badge: "Pending",
    schedule: {
      pending_reason: "different_schedule",
      next_reconcile_at: null,
      requested: null,
      inherited: { crons: ["0 0 * * *"], origin: "default" },
    },
    status: `${different} Takes effect after the next check.`,
    rows: ["Target · built-in default 0 0 * * * UTC", running],
  },
  {
    name: "awaiting reconciliation",
    badge: "Pending",
    schedule: { pending_reason: "awaiting_reconcile", requested: null },
    status: "The deployment schedule is shown after 12:15 UTC.",
    rows: [running],
  },
  {
    name: "a live observation from another day in a named timezone",
    badge: "Pending",
    schedule: {
      pending_reason: "awaiting_reconcile",
      requested: null,
      live: {
        ...live,
        observed_at: "2026-01-12T00:19:00Z",
        timezone: "Europe/Sofia",
      },
    },
    status: "The deployment schedule is shown after 12:15 UTC.",
    rows: [
      "Running · as of 12 Jan 2026 · 00:19:00 0 3 * * *; 0 15 * * * Europe/Sofia",
    ],
  },
  {
    name: "a live observation from another year with controller time",
    badge: "Pending",
    schedule: {
      pending_reason: "awaiting_reconcile",
      requested: null,
      live: {
        ...live,
        observed_at: "2025-11-12T00:19:00Z",
        timezone: null,
      },
    },
    status: "The deployment schedule is shown after 12:15 UTC.",
    rows: [
      "Running · as of 12 Nov 2025 · 00:19:00 0 3 * * *; 0 15 * * * controller time",
    ],
  },
  {
    name: "Not scheduled yet with a saved target",
    badge: "Not scheduled yet",
    schedule: {
      pending_reason: "no_cronworkflow",
      live: null,
      requested: { ...requested, updated_at: "2026-01-14T23:43:00Z" },
    },
    status:
      "This instance has no sync schedule yet. Starts by 12:15 UTC. No sync job runs until then.",
    rows: ["Target · saved by you on 14 Jan 2026 · 23:43:00 0 6 * * * UTC"],
  },
  {
    name: "Not scheduled yet without a saved target",
    badge: "Not scheduled yet",
    schedule: {
      pending_reason: "no_cronworkflow",
      live: null,
      requested: null,
    },
    status:
      "This instance has no sync schedule yet. Starts by 12:15 UTC. No sync job runs until then.",
    rows: [],
  },
  {
    name: "applied without a live observation",
    badge: "Set by admin",
    schedule: { status: "applied", live: null, inherited: deployment },
    status:
      "Saved by you at 12:00 UTC. The live schedule has not been recorded yet.",
    rows: ["Deployment · connector default 0 2 * * * UTC"],
  },
  {
    name: "Paused",
    badge: "Paused",
    schedule: { status: "paused" },
    status: "The sync job is paused. No sync runs are scheduled.",
    rows: [],
  },
  {
    name: "Can't read",
    badge: "Can't read",
    schedule: { status: null, read_error: "Could not read the sync job." },
    status: "Could not read the sync job.",
    rows: [],
  },
  {
    name: "Not loaded",
    badge: "Not loaded",
    status: "The schedule has not been loaded yet.",
    rows: [],
  },
])("renders the status and schedule rows for $name", async (test) => {
  if (test.schedule) {
    Object.assign(mocks.query.data!.schedule, {
      live,
      next_reconcile_at: nextCheck,
      ...test.schedule,
    });
  } else {
    mocks.query.data = undefined;
    mocks.query.isError = true;
  }

  render(pane());
  await userEvent.hover(screen.getByText(test.badge).closest("[tabindex]")!);

  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.querySelector("p")?.textContent).toBe(test.status);
  const rows = within(tooltip).queryAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual(test.rows);
  expect(rows.every((row) => row.querySelector("code"))).toBe(true);
});

it.each<{
  name: string;
  inherited: InheritedSchedule | null;
  status?: string;
  rows: string[];
}>([
  {
    name: "a known target",
    inherited: { crons: ["0 0 * * *"], origin: "api" },
    status: undefined,
    rows: ["Target · API 0 0 * * * UTC"],
  },
  {
    name: "an unknown target",
    inherited: null,
    status: "The deployment schedule is shown after 12:15 UTC.",
    rows: [],
  },
])("renders the editor reset tooltip for $name", async (test) => {
  mocks.query.data!.schedule.inherited = test.inherited;
  mocks.query.data!.schedule.next_reconcile_at = nextCheck;
  render(pane());

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const reset = screen.getByRole("button", { name: "Reset to default" });
  await userEvent.hover(reset.closest("[tabindex]")!);

  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.querySelector("p")?.textContent).toBe(test.status);
  expect(
    within(tooltip)
      .queryAllByRole("listitem")
      .map((row) => row.textContent)
  ).toEqual(test.rows);
});
