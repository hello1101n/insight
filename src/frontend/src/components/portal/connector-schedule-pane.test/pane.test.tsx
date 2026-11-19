import { pickPreset, presetLabel } from "./preset";
import { mocks, row, NOW, read, pane, editCustom } from "./fixtures";

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { ConnectorsApiError } from "@/api/connectors-client";
import { scheduleClock } from "@/lib/portal/connector-schedule-time";
import { ConnectorSchedulePane } from "../connector-schedule-pane";

it("shows Edit when the loaded schedule response has no editable field", async () => {
  expect(mocks.query.data!.schedule).not.toHaveProperty("editable");
  render(pane());

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("combobox", { name: "Runs" })).toHaveFocus();
});

it("wraps schedule values, attribution and status inside a nowrap table cell", () => {
  const { container } = render(
    <div className="whitespace-nowrap">{pane()}</div>
  );
  const content = screen.getByRole("heading", { name: "Schedule" })
    .parentElement!.parentElement!;
  expect(content).toHaveClass(
    "min-w-0",
    "whitespace-normal",
    "[overflow-wrap:anywhere]"
  );
  expect(content).not.toHaveClass("whitespace-nowrap");
  expect(container.querySelector('[data-slot="schedule-value"]')).toHaveClass(
    "min-w-0",
    "flex-wrap"
  );
  expect(screen.getByText(/Saved by you/).closest("header")).toHaveClass(
    "min-w-0",
    "flex-wrap"
  );
  expect(container.querySelector("[aria-live]")).not.toHaveClass(
    "whitespace-nowrap"
  );
});

it("contains the custom field and wraps editor errors and help inside a nowrap table cell", async () => {
  const description =
    "The expression is invalid. Choose starts at least 120 minutes apart and save the schedule again.";
  mocks.save.mockRejectedValue(
    new ConnectorsApiError(400, {
      context: { field_violations: [{ description }] },
    })
  );
  render(<div className="whitespace-nowrap">{pane()}</div>);
  const field = await editCustom();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(description);

  const form = field.closest("form");
  expect(form).toHaveClass(
    "min-w-0",
    "whitespace-normal",
    "[overflow-wrap:anywhere]"
  );
  expect(field.closest("fieldset")).toHaveClass("min-w-0");
  expect(field).toHaveClass("w-[24ch]", "min-w-0", "max-w-full");
  for (const text of [description, /UTC · minute hour day month weekday/]) {
    expect(screen.getByText(text).closest("form"), String(text)).toBe(form);
    expect(screen.getByText(text), String(text)).not.toHaveClass(
      "whitespace-nowrap"
    );
  }
});

it.each([
  ["hours-1", "at minute", "Minute", "text"],
  ["hours-6", "starting", "Start time", "time"],
  ["hours-2", "starting", "Start time", "time"],
  ["hours-3", "starting", "Start time", "time"],
  ["hours-4", "starting", "Start time", "time"],
  ["hours-8", "starting", "Start time", "time"],
  ["hours-12", "starting", "Start time", "time"],
  ["daily", "at", "Time", "time"],
  ["weekdays", "at", "Time", "time"],
] as const)(
  "shows a compact inline field for %s",
  async (value, connector, label, type) => {
    render(pane());
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("combobox", { name: "Runs" })).toHaveFocus();
    await pickPreset(value);
    const input =
      type === "text"
        ? screen.getByLabelText(label)
        : screen.getByRole("group", { name: label });
    const controls =
      type === "text" ? [input] : within(input).getAllByRole("combobox");
    if (type === "text") expect(input).toHaveAttribute("type", "text");
    else {
      expect(controls).toHaveLength(2);
      expect(
        within(input).getByRole("combobox", { name: "Hour" })
      ).toBeInTheDocument();
      expect(
        within(input).getByRole("combobox", { name: "Minute" })
      ).toBeInTheDocument();
      expect(input.querySelector('input[type="time"]')).toBeNull();
    }
    for (const control of controls)
      expect(control).toHaveClass("w-[64px]", "max-w-full", "min-w-0");
    expect(
      within(input.parentElement!.closest(".flex")!).getByText(connector)
    ).toBeInTheDocument();
    expect(
      within(input.closest(".contents")!).getByText("UTC")
    ).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  }
);

it("keeps recorded and requested schedules separate with compact attribution", () => {
  const { container } = render(pane());
  expect(screen.getByText(/Until then:/)).toHaveTextContent(
    "Until then: every day at 03:00"
  );
  expect(screen.getByText("0 6 * * *")).toBeInTheDocument();
  expect(screen.getByText("Saved by you at 12:00 UTC.")).toBeInTheDocument();
  expect(
    container.querySelector('[aria-live="polite"] > span')
  ).toBeEmptyDOMElement();
});

it.each([false, true])(
  "keeps an unchanged waiting schedule disabled, cleared: %s",
  async (cleared) => {
    mocks.query.data!.schedule.status = "pending";
    if (cleared) mocks.query.data!.schedule.requested!.crons = [];

    mocks.query.data!.schedule.requested!.updated_by =
      "00000000-0000-4000-8000-000000000002";
    mocks.save.mockResolvedValue(read());
    render(pane());
    expect(Boolean(screen.queryByText(/Saved by another admin/))).toBe(
      !cleared
    );
    expect(screen.getByText("Pending").closest("[title]")).toHaveClass(
      "text-warning"
    );
    expect(
      screen.getByText("Takes effect after the next check.")
    ).toBeInTheDocument();
    await userEvent.hover(screen.getByText("Pending").closest("[tabindex]")!);
    expect(await screen.findByRole("tooltip")).not.toHaveTextContent(
      "attempted at"
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      `Running · as of ${scheduleClock(NOW)}`
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
  }
);

it.each(["pending"] as const)(
  "dates an Applied transition from %s with the acknowledgement observed_at",
  async (status) => {
    mocks.query.data!.schedule.status = status;
    const view = render(pane());
    const observedAt = "2026-01-15T12:17:00Z";
    mocks.query.data!.schedule.status = "applied";
    mocks.query.data!.schedule.live!.observed_at = observedAt;
    view.rerender(pane());
    expect(screen.getByText("Set by admin")).toBeInTheDocument();
    await userEvent.hover(
      screen.getByText("Set by admin").closest("[tabindex]")!
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      `Running · as of ${scheduleClock(observedAt)}`
    );
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  }
);

it.each(["pending"] as const)(
  "omits Set by while a %s request differs",
  (status) => {
    mocks.query.data!.schedule.status = status;
    render(pane());
    expect(screen.queryByText("Set by")).not.toBeInTheDocument();
  }
);

it("keeps applied confirmation visible when the pane reopens", () => {
  const view = render(pane());
  mocks.query.data!.schedule.status = "applied";
  view.rerender(pane());
  expect(screen.getByText("Set by admin")).toBeInTheDocument();
  expect(screen.queryByText("Requested")).not.toBeInTheDocument();
  view.rerender(pane());
  expect(screen.getByText("Set by admin")).toBeInTheDocument();
  view.unmount();
  render(pane());
  expect(screen.getByText("Set by admin")).toBeInTheDocument();
});

it("renders no recorded schedule as unknown and hides requested once inherited", () => {
  mocks.query.data!.schedule.status = "inherited";
  mocks.query.data!.schedule.requested = null;
  mocks.query.data!.schedule.live = null;
  render(
    <ConnectorSchedulePane row={{ ...row, schedule: null }} polling={false} />
  );
  expect(screen.getAllByText("—")).toHaveLength(1);
  expect(screen.queryByText("Requested")).not.toBeInTheDocument();
});

it("shows the running schedule without override attribution after an inherited clear", () => {
  mocks.query.data!.schedule.status = "inherited";
  mocks.query.data!.schedule.requested!.crons = [];
  mocks.query.data!.schedule.inherited = {
    crons: ["0 3 * * *"],
    origin: "annotation",
  };
  render(pane());

  expect(screen.getByText("0 3 * * *").parentElement).toHaveTextContent("UTC");
  expect(screen.queryByText("Set by")).not.toBeInTheDocument();
  expect(screen.queryByText("Requested")).not.toBeInTheDocument();
  expect(
    screen.queryByText(/overridden by this request/)
  ).not.toBeInTheDocument();
});

it.each([
  ["annotation", "Target · instance settings"],
  ["descriptor", "Target · connector default"],
  ["default", "Target · built-in default"],
] as const)(
  "names the deployment schedule and origin for a pending reset from %s",
  async (origin, source) => {
    mocks.query.data!.schedule.pending_reason = "different_schedule";
    mocks.query.data!.schedule.requested!.crons = [];
    mocks.query.data!.schedule.inherited = {
      crons: ["0 2 * * *", "0 14 * * *"],
      origin,
    };
    render(pane());

    expect(screen.getByText("0 2 * * *; 0 14 * * *")).toBeInTheDocument();
    const badge = screen.getByText("Pending");
    await userEvent.hover(badge.closest("[tabindex]")!);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(source);
    expect(screen.queryByText(/Saved by you/)).not.toBeInTheDocument();
    expect(screen.queryByText("The default schedule")).not.toBeInTheDocument();
    expect(screen.queryByText("Set by")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/overridden by this request/)
    ).not.toBeInTheDocument();
  }
);

it.each(["pending"] as const)(
  "does not invent a deployment origin for a %s clear without inherited facts",
  (status) => {
    mocks.query.data!.schedule.status = status;
    mocks.query.data!.schedule.requested!.crons = [];
    render(pane());

    expect(screen.getByText("Default schedule")).toBeInTheDocument();
    expect(screen.queryByText(/Saved by you/)).not.toBeInTheDocument();
    expect(screen.queryByText("The default schedule")).not.toBeInTheDocument();
  }
);

it("submits the custom list with the last ETag, then closes and restores focus", async () => {
  mocks.save.mockResolvedValue(read());
  render(pane());
  await editCustom("0 9 * * *");
  await userEvent.click(
    screen.getByRole("button", { name: "+ Add expression" })
  );
  await userEvent.type(
    screen.getByRole("textbox", { name: "Cron expression 2" }),
    "0 18 * * *"
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      etag: '"2"',
      crons: ["0 9 * * *", "0 18 * * *"],
    })
  );
  expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus();
  expect(
    screen.getByText("Takes effect after the next check.")
  ).toBeInTheDocument();
});

it("shows every 400 description under Custom and keeps the input intact", async () => {
  mocks.save.mockRejectedValue(
    new ConnectorsApiError(400, {
      context: {
        field_violations: [
          { field: "crons[0]", description: "Minute field is invalid." },
          { field: "crons[0]", description: "Hour field is invalid." },
        ],
      },
    })
  );
  render(pane());
  await editCustom();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(/Minute field is invalid/)
  ).toBeInTheDocument();
  expect(screen.getByText(/Hour field is invalid/)).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("0 7 * * *");
  expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
});

it("reloads a 412 into the open editor and uses the reloaded ETag on the next save", async () => {
  const next = read();
  next.etag = '"3"';
  next.schedule.requested = {
    crons: ["0 9 * * 0"],
    updated_at: "2026-01-15T12:29:00Z",
    updated_by: "00000000-0000-4000-8000-000000000002",
  };
  mocks.query.refetch.mockResolvedValue({ data: next });
  mocks.save
    .mockRejectedValueOnce(new ConnectorsApiError(412, null))
    .mockResolvedValueOnce(next);
  render(pane());
  await editCustom("0 8 * * *");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(/Another admin changed this schedule at/)
  ).toHaveTextContent("It is reloaded below; check it and save again.");
  expect(screen.getByRole("textbox")).toHaveValue("0 9 * * 0");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "0 10 * * 0" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenLastCalledWith({
      etag: '"3"',
      crons: ["0 10 * * 0"],
    })
  );
});

it("keeps input when a conflict reload fails", async () => {
  mocks.save.mockRejectedValue(new ConnectorsApiError(412, null));
  mocks.query.refetch.mockResolvedValue({
    error: new Error("synthetic failure"),
  });
  render(pane());
  await editCustom("0 8 * * *");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(/Could not reload the changed schedule/)
  ).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveValue("0 8 * * *");
});

it("restores the live schedule when a failed save cannot be reloaded", async () => {
  mocks.save.mockRejectedValue(new ConnectorsApiError(500, null));
  render(pane());
  await editCustom();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(
    await screen.findByText(/Could not save the schedule/)
  ).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Hour" })).toHaveTextContent(
    "03"
  );
});

it("resets with If-Match and closes after success", async () => {
  mocks.save.mockResolvedValue(read());
  render(pane());
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Reset to default" })
  );
  expect(mocks.save).toHaveBeenCalledWith({ etag: '"2"', crons: null });
  expect(await screen.findByRole("button", { name: "Edit" })).toHaveFocus();
});

it.each(["Cancel", "Escape"])(
  "%s cancels without writing and returns focus to Edit",
  async (method) => {
    render(pane());
    const field = await editCustom();
    if (method === "Cancel")
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else fireEvent.keyDown(field, { key: "Escape" });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus();
  }
);

it("prefills the compiled request", async () => {
  mocks.query.data!.schedule.requested!.crons = ["0 0,6,12,18 * * *"];
  render(pane());
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(
    within(screen.getByRole("combobox", { name: "Runs" })).getByText(
      presetLabel("hours-6"),
      { exact: true }
    )
  ).toBeInTheDocument();
});

it("prefills the recorded schedule without a request and hides Reset", async () => {
  mocks.query.data!.schedule.requested = null;
  render(pane());
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(
    within(screen.getByRole("combobox", { name: "Runs" })).getByText(
      presetLabel("daily"),
      { exact: true }
    )
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Reset to default" })
  ).not.toBeInTheDocument();
});

it("offers retry after a schedule read error", async () => {
  mocks.query.isError = true;
  mocks.query.data = undefined;
  render(pane());
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.query.refetch).toHaveBeenCalled();
});

it.each(["annotation", "descriptor", "default"] as const)(
  "omits the override chip for a saved schedule over %s",
  (origin) => {
    mocks.query.data!.schedule.inherited = { crons: ["0 2 * * *"], origin };
    render(pane());
    expect(screen.queryByText("overrides default")).not.toBeInTheDocument();
  }
);

it("hides the deployment override line when no request exists", () => {
  mocks.query.data!.schedule.inherited = {
    crons: ["0 2 * * *"],
    origin: "annotation",
  };
  mocks.query.data!.schedule.requested = null;
  render(pane());
  expect(screen.queryByText("overrides default")).not.toBeInTheDocument();
});

it.each([true, false])(
  "names the reset destination when recorded: %s",
  async (known) => {
    mocks.query.data!.schedule.inherited = known
      ? { crons: ["0 2 * * *"], origin: "descriptor" }
      : null;
    render(pane());
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const reset = screen.getByRole("button", { name: "Reset to default" });
    await userEvent.hover(reset.closest("[tabindex]")!);
    const tooltip = await screen.findByRole("tooltip");
    if (known) {
      expect(tooltip).toHaveTextContent("Target · connector default");
      expect(tooltip).toHaveTextContent("0 2 * * * UTC");
    } else {
      expect(tooltip).toHaveTextContent(
        "The deployment schedule is shown after the next check."
      );
    }
  }
);

it("shows the built-in reset schedule once in the editor tooltip", async () => {
  mocks.query.data!.schedule.inherited = {
    crons: ["0 0 * * *"],
    origin: "default",
  };
  render(pane());

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const reset = screen.getByRole("button", { name: "Reset to default" });
  await userEvent.hover(reset.closest("[tabindex]")!);
  const tooltip = await screen.findByRole("tooltip");
  expect(within(tooltip).getByRole("listitem")).toHaveTextContent(
    /^Target · built-in default 0 0 \* \* \* UTC$/
  );
});

it("shows the live schedule even when the summary still has the previous schedule", () => {
  mocks.query.data!.schedule.live!.crons = ["0 8 * * *"];
  render(pane());
  const running = screen.getByText(/Until then:/);
  expect(running).toHaveTextContent("every day at 08:00");
  expect(running).not.toHaveTextContent("0 3 * * *");
});

it.each([
  {
    crons: ["0 3 * * *", "0 15 * * *"],
    count: "2 cron expressions",
  },
  { crons: ["H * * * *"], count: "1 cron expression" },
])(
  "uses $count when the running crons have no short description",
  ({ crons, count }) => {
    const schedule = mocks.query.data!.schedule;
    schedule.pending_reason = "different_schedule";
    schedule.requested!.crons = [];
    schedule.inherited = {
      crons: ["0 3 * * *", "0 14 * * *"],
      origin: "annotation",
    };
    schedule.live!.crons = crons;
    render(pane());

    expect(screen.getByText(/Until then:/)).toHaveTextContent(
      `Until then: ${count}, UTC.`
    );
  }
);

it("counts cron expressions in the displayed schedule", () => {
  mocks.query.data!.schedule.requested!.crons = ["0 3 * * *", "0 14 * * *"];
  render(pane());
  expect(screen.getByText("2 cron expressions", { exact: true })).toBeVisible();
});

it("lists the cron expressions together in the editor reset tooltip", async () => {
  mocks.query.data!.schedule.inherited = {
    crons: ["0 3 * * *", "0 14 * * *"],
    origin: "annotation",
  };
  render(pane());

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const reset = screen.getByRole("button", { name: "Reset to default" });
  await userEvent.hover(reset.closest("[tabindex]")!);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Target · instance settings 0 3 * * *; 0 14 * * * UTC"
  );
});

it("does not present the summary schedule as live when no CronWorkflow exists", () => {
  mocks.query.data!.schedule.live = null;
  mocks.query.data!.schedule.pending_reason = "no_cronworkflow";
  render(pane());
  expect(screen.queryByText(/Until then:/)).not.toBeInTheDocument();
  expect(screen.getByText("0 6 * * *")).toBeInTheDocument();
});

it.each(["initial query error", "no data", "no source id"] as const)(
  "shows Not loaded when the page has %s",
  (reason) => {
    mocks.query.isError = reason.endsWith("error");
    mocks.query.isPending = reason === "no source id";
    mocks.query.data = reason === "no source id" ? read() : undefined;
    render(
      reason === "no source id" ? pane({ ...row, source_id: null }) : pane()
    );

    expect(screen.getByText("Not loaded")).toBeInTheDocument();
    expect(screen.queryByText("Can't read")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit" })
    ).not.toBeInTheDocument();
  }
);
