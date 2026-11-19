import { mocks, pane } from "./fixtures";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";

it("omits saved-by attribution from a pending clear tooltip", async () => {
  mocks.query.data!.schedule.requested!.crons = [];
  render(pane());
  await userEvent.hover(screen.getByText("Pending").closest("[tabindex]")!);

  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip).toHaveTextContent("Running · as of");
  expect(tooltip).not.toHaveTextContent(/saved by/i);
});

it("explains the header chip on hover and keyboard focus with a status and a running row", async () => {
  mocks.query.data!.schedule.status = "inherited";
  mocks.query.data!.schedule.requested = null;
  mocks.query.data!.schedule.inherited = {
    crons: ["0 2 * * *", "0 14 * * *"],
    origin: "annotation",
  };
  render(pane());
  const trigger = screen.getByText("Default").closest("[tabindex]")!;
  const user = userEvent.setup();
  for (const gesture of ["hover", "focus"]) {
    if (gesture === "hover") await user.hover(trigger);
    else {
      await user.tab();
      expect(trigger).toHaveFocus();
    }
    const tooltip = await screen.findByRole("tooltip");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip.querySelector("p"), gesture).toHaveTextContent(
      "Runs the schedule set at deployment in instance settings."
    );
    const row = within(tooltip).getByRole("listitem");
    expect(row, gesture).toHaveTextContent(
      "Running · as of 12:00 0 3 * * * UTC"
    );
    expect(row.querySelector("code")).toHaveTextContent("0 3 * * *");
    await user.unhover(trigger);
    if (gesture === "focus") await user.tab();
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    );
  }
});

it.each([
  ["no_cronworkflow", "This instance has no sync schedule yet"],
  [
    "awaiting_reconcile",
    "The deployment schedule is shown after the next check",
  ],
  ["different_schedule", "The sync job runs a different schedule"],
] as const)(
  "explains the pending reason in the header and tooltip: %s",
  async (pending_reason, wording) => {
    mocks.query.data!.schedule.pending_reason = pending_reason;
    render(pane());
    const header = screen.getByText(
      pending_reason === "no_cronworkflow" ? "Not scheduled yet" : "Pending"
    );
    expect(screen.getByText(new RegExp(wording))).toBeInTheDocument();
    await userEvent.hover(header.closest("[tabindex]")!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(`${wording}.`);
  }
);

it("puts the deployment annotation behind Details on the default pane", async () => {
  const schedule = mocks.query.data!.schedule;
  schedule.status = "inherited";
  schedule.requested = null;
  schedule.inherited = { crons: ["0 3 * * *"], origin: "annotation" };
  render(pane());

  const annotation = screen.getByText("insight.cyberfabric.com/schedule");
  expect(annotation).not.toBeVisible();
  await userEvent.click(screen.getByText("Details"));
  expect(annotation).toBeVisible();
});

it.each(["descriptor", "default", "api"] as const)(
  "omits the operator annotation details for the %s origin",
  (origin) => {
    const schedule = mocks.query.data!.schedule;
    schedule.status = "inherited";
    schedule.requested = null;
    schedule.inherited = { crons: ["0 3 * * *"], origin };
    render(pane());

    expect(screen.queryByText("Details")).not.toBeInTheDocument();
    expect(
      screen.queryByText("insight.cyberfabric.com/schedule")
    ).not.toBeInTheDocument();
  }
);
