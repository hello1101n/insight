import { pickPreset } from "./preset";
import { mocks, pane, read, pickTimePart } from "./fixtures";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ConnectorSchedulePane } from "../connector-schedule-pane";
import { row } from "./fixtures";

it.each(["no_cronworkflow", "awaiting_reconcile"] as const)(
  "explains %s with a reconcile time or an honest fallback",
  (reason) => {
    for (const known of [true, false]) {
      mocks.query.data!.schedule.pending_reason = reason;
      mocks.query.data!.schedule.next_reconcile_at = known
        ? "2026-01-15T12:15:00Z"
        : null;
      render(pane());
      expect(screen.queryByText(/✓ Saved/)).not.toBeInTheDocument();
      expect(screen.queryByText(/First sync/i)).not.toBeInTheDocument();
      const copy = screen.getByText(
        known
          ? reason === "awaiting_reconcile"
            ? "The deployment schedule is shown after 12:15 UTC."
            : "Starts by 12:15 UTC."
          : reason === "awaiting_reconcile"
            ? "The deployment schedule is shown after the next check."
            : "Takes effect after the next check."
      );
      expect(copy.closest("[data-slot]")).toHaveAttribute(
        "data-slot",
        "schedule-hint"
      );
      cleanup();
    }
  }
);

it("warns only after two known reconcile intervals", () => {
  const schedule = mocks.query.data!.schedule;
  schedule.pending_reason = "awaiting_reconcile";
  schedule.requested!.updated_at = "2026-01-15T11:45:00Z";
  schedule.reconcile_interval_secs = 450;
  const view = render(pane());
  expect(screen.getByText(/Not applied after 15 minutes/)).toHaveClass(
    "text-warning"
  );
  schedule.reconcile_interval_secs = null;
  view.rerender(pane());
  expect(screen.queryByText(/Not applied after/)).not.toBeInTheDocument();
  schedule.reconcile_interval_secs = 451;
  view.rerender(pane());
  expect(screen.queryByText(/Not applied after/)).not.toBeInTheDocument();
});

it("uses the measured reconcile interval for a delayed request when the API estimate is unknown", () => {
  mocks.query.data!.schedule.pending_reason = "awaiting_reconcile";
  mocks.query.data!.schedule.requested!.updated_at = "2026-01-15T11:40:00Z";
  render(
    <ConnectorSchedulePane
      row={row}
      polling={false}
      reconcileIntervalSecs={600}
    />
  );
  expect(screen.getByText(/Not applied after 20 minutes/)).toBeInTheDocument();
});

it("uses the API reconcile interval before the measured interval", () => {
  const schedule = mocks.query.data!.schedule;
  schedule.pending_reason = "different_schedule";
  schedule.requested!.updated_at = "2026-01-15T11:59:00Z";
  schedule.reconcile_interval_secs = 30;
  render(
    <ConnectorSchedulePane
      row={row}
      polling={false}
      reconcileIntervalSecs={600}
    />
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Not applied after 1 minute"
  );
});

it("uses singular minutes for a one-minute delay", () => {
  const schedule = mocks.query.data!.schedule;
  schedule.pending_reason = "different_schedule";
  schedule.requested!.updated_at = "2026-01-15T11:59:00Z";
  schedule.reconcile_interval_secs = 30;
  render(pane());

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Not applied after 1 minute."
  );
});

it("shows the next check for a saved schedule", async () => {
  const schedule = mocks.query.data!.schedule;
  schedule.pending_reason = "different_schedule";
  schedule.next_reconcile_at = "2026-01-15T12:01:00Z";
  const view = render(pane());
  const label = "Pending";
  await userEvent.hover(screen.getByText(label).closest("[tabindex]")!);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Starts by 12:01 UTC."
  );
  expect(
    within(
      view.container.querySelector<HTMLElement>('[data-slot="schedule-hint"]')!
    ).getByText("Starts by 12:01 UTC.")
  ).toBeInTheDocument();
  schedule.next_reconcile_at = null;
  view.rerender(pane());
  expect(screen.getByRole("tooltip")).toHaveTextContent(
    "Takes effect after the next check."
  );
});

it("confirms an immediate application and previews three live runs in UTC", () => {
  const schedule = mocks.query.data!.schedule;
  schedule.status = "applied";
  schedule.live!.crons = ["*/5 * * * *", "5 * * * *"];
  const view = render(pane());
  expect(screen.getByText("Set by admin")).toBeInTheDocument();
  expect(screen.queryByText(/Saved and applied at/)).not.toBeInTheDocument();
  const preview = screen.getByText("Next (UTC)").parentElement!;
  expect(within(preview).getAllByRole("listitem")).toHaveLength(3);
  const first = preview.querySelector("time")!;
  expect(first).toHaveAttribute("datetime", "2026-01-15T12:05:00.000Z");
  expect(first).toHaveTextContent("12:05");
  schedule.live!.suspended = true;
  view.rerender(pane());
  expect(screen.getByText("Suspended")).toBeInTheDocument();
  expect(screen.queryByText(/First sync.*12:05/)).not.toBeInTheDocument();
});

it("shows a default badge and keeps the reset origin in its tooltip", async () => {
  const schedule = mocks.query.data!.schedule;
  schedule.status = "inherited";
  schedule.requested!.crons = [];
  schedule.inherited = { crons: ["0 3 * * *"], origin: "descriptor" };
  render(pane());
  expect(screen.queryByText(/Reset at/)).not.toBeInTheDocument();
  await userEvent.hover(screen.getByText("Default").closest("[tabindex]")!);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Runs the connector's default schedule."
  );
  expect(screen.getByText("Every day at 03:00")).not.toHaveTextContent("..");
});

it("replaces the hourly minute, previews the draft and sends a numeric minute cron", async () => {
  mocks.query.data!.schedule.requested!.crons = ["0 * * * *"];
  mocks.save.mockResolvedValue(read());
  render(pane());
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const minute = screen.getByRole("spinbutton", { name: "Minute" });
  expect(minute).toHaveValue("00");
  await userEvent.type(minute, "22");
  expect(minute).toHaveValue("22");
  expect(screen.getByText("22 * * * *")).toBeInTheDocument();
  expect(
    screen.getByText("Proposed runs (UTC)").parentElement!.querySelector("time")
  ).toHaveTextContent("12:22");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mocks.save).toHaveBeenCalledWith({
    etag: '"2"',
    crons: ["22 * * * *"],
  });
});

it("rejects out of range and empty minutes and wraps keyboard steps", async () => {
  mocks.query.data!.schedule.requested!.crons = ["0 * * * *"];
  render(pane());
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const minute = screen.getByRole("spinbutton", { name: "Minute" });
  await userEvent.type(minute, "75");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(minute).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText("Enter a minute from 0 to 59.")).toBeInTheDocument();
  fireEvent.submit(minute.closest("form")!);
  expect(mocks.save).not.toHaveBeenCalled();
  await userEvent.clear(minute);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.keyboard("{Home}{ArrowDown}");
  expect(minute).toHaveAttribute("aria-valuenow", "59");
  await userEvent.keyboard("{ArrowUp}");
  expect(minute).toHaveValue("0");
  await userEvent.tab();
  expect(minute).toHaveValue("00");
  await userEvent.click(minute);
  fireEvent.keyDown(minute, { key: "End" });
  expect(minute).toHaveValue("59");
  await userEvent.type(minute, "22", { skipClick: true });
  expect(minute).toHaveValue("22");
  await userEvent.keyboard("{Backspace}");
  expect(minute).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

it.each(["daily", "hours-2", "weekdays"])(
  "disables Save for incomplete %s time until both kit selects are chosen",
  async (preset) => {
    mocks.query.data!.schedule.requested!.crons = ["0 * * * *"];
    const { container } = render(pane());
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.clear(screen.getByRole("spinbutton", { name: "Minute" }));
    const runs = screen.getByRole("combobox", { name: "Runs" });
    await pickPreset(preset);
    expect(container.querySelector('input[type="time"]')).toBeNull();
    expect(screen.getByRole("combobox", { name: "Hour" })).toHaveTextContent(
      "—"
    );
    expect(screen.getByRole("combobox", { name: "Minute" })).toHaveTextContent(
      "—"
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByText(/Stored as/)).not.toBeInTheDocument();
    fireEvent.submit(runs.closest("form")!);
    expect(mocks.save).not.toHaveBeenCalled();
    await pickTimePart("Hour", "09");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await pickTimePart("Minute", "30");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getAllByText("Proposed runs (UTC)")).toHaveLength(1);
    expect(screen.queryByText(/your time/)).not.toBeInTheDocument();
  }
);
