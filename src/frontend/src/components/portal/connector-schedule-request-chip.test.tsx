import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConnectorSchedule,
  ScheduleStatus,
} from "@/api/connector-health-client";

const mocks = vi.hoisted(() => ({
  schedule: undefined as ConnectorSchedule | undefined,
  summaryStatus: "pending" as ScheduleStatus,
  summaryError: null as string | null,
  scheduleError: false,
  scheduleFetching: false,
  reads: vi.fn(),
}));

vi.mock("@/queries/connector-schedule-author", () => ({
  useConnectorScheduleAuthor: (personId: string | undefined) =>
    personId === "00000000-0000-4000-8000-000000000001"
      ? "you"
      : "another admin",
}));
vi.mock("@/queries/connector-health", () => ({
  useConnectorSchedule: () => {
    mocks.reads();
    return {
      data: mocks.schedule ? { schedule: mocks.schedule } : undefined,
      isError: mocks.scheduleError,
      isFetching: mocks.scheduleFetching,
    };
  },
  useConnectorHealth: () => ({
    data: {
      as_of: "2026-01-15T12:00:00Z",
      history_available: true,
      connectors: [
        {
          connector: "example-tracker",
          source_id: "main",
          configured: true,
          schedule_request: {
            revision: 3,
            read_error: mocks.summaryError,
            crons: ["0 6 * * *"],
            last_observation: {
              status: mocks.summaryStatus,
              observed_at: "2026-01-15T12:00:00Z",
            },
          },
        },
      ],
    },
  }),
}));

import { ConnectorHealthPane } from "./connector-health";
import { AppTooltips } from "@/test/tooltip";

beforeEach(() => {
  mocks.schedule = undefined;
  mocks.summaryStatus = "pending";
  mocks.summaryError = null;
  mocks.scheduleError = false;
  mocks.scheduleFetching = false;
  mocks.reads.mockClear();
});
afterEach(() => vi.useRealTimers());

it("shows only a status paragraph in the Next sync icon tooltip while details load", async () => {
  render(<ConnectorHealthPane />, { wrapper: AppTooltips });
  const row = screen.getByRole("row", { expanded: false });
  await userEvent.hover(within(row).getByRole("img", { name: "Pending" }));

  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.querySelector("p")?.textContent).toBe(
    "Pending. Schedule details are loading."
  );
  expect(within(tooltip).queryAllByRole("listitem")).toHaveLength(0);
});

it("explains the collapsed chip's status and loading state on hover and keyboard focus", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2026-01-15T12:00:00Z");
  render(<ConnectorHealthPane />, { wrapper: AppTooltips });
  const row = screen.getByRole("row", { expanded: false });
  const trigger = within(row).getByRole("img", {
    name: "Pending",
  });
  expect(trigger).toHaveAccessibleName("Pending");
  const user = userEvent.setup();
  for (const gesture of ["hover", "focus"]) {
    if (gesture === "hover") await user.hover(trigger);
    else {
      for (
        let stop = 0;
        stop < 5 && document.activeElement !== trigger;
        stop++
      ) {
        await user.tab();
      }
      expect(trigger).toHaveFocus();
    }
    const tooltip = await screen.findByRole("tooltip");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip.querySelector("p"), gesture).toHaveTextContent(
      "Pending. Schedule details are loading."
    );
    expect(row).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    expect(row).toHaveAttribute("aria-expanded", "false");
    await user.unhover(trigger);
    await user.tab();
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    );
  }
});

describe.each([false, true])(
  "loaded pending details with query error %s",
  (queryError) => {
    it.each([
      [
        "no_cronworkflow",
        "Not scheduled yet",
        "This instance has no sync schedule yet",
        "lucide-clock",
        "text-warning",
      ],
      [
        "awaiting_reconcile",
        "Pending",
        "The deployment schedule is shown after the next check",
        "lucide-clock",
        "text-warning",
      ],
      [
        "different_schedule",
        "Pending",
        "The sync job runs a different schedule",
        "lucide-clock",
        "text-warning",
      ],
    ] as const)(
      "keeps loaded pending details: %s",
      async (pending_reason, label, wording, icon, tone) => {
        mocks.scheduleError = queryError;
        mocks.schedule = {
          connector: "example-tracker",
          source_id: "main",
          revision: 3,
          status: "pending",
          pending_reason,
          requested: {
            crons: ["0 6 * * *"],
            updated_by: "00000000-0000-4000-8000-000000000001",
            updated_at: "2026-01-15T12:00:00Z",
          },
          live: null,
          inherited: null,
        };
        render(<ConnectorHealthPane />, { wrapper: AppTooltips });
        const chip = screen.getByRole("img", { name: label });
        const mark = chip.querySelector(
          '[data-slot="schedule-request-status"]'
        )!;
        expect(mark).toHaveAttribute("title", label);
        expect(mark).toHaveClass("size-4", "shrink-0", tone);
        expect(mark.querySelector(`.${icon}`)).toHaveAttribute(
          "aria-hidden",
          "true"
        );
        expect(chip.textContent).toBe("");
        await userEvent.hover(chip);
        expect(await screen.findByRole("tooltip")).toHaveTextContent(
          `${wording}.`
        );
        expect(screen.getByRole("tooltip")).not.toHaveTextContent(
          "Schedule details could not be loaded."
        );
        expect(
          screen.getByRole("row", { expanded: false })
        ).toBeInTheDocument();
      }
    );
  }
);

it("shows waiting as an inline warning icon with an accessible name and tooltip", async () => {
  mocks.summaryStatus = "pending";
  render(<ConnectorHealthPane />, { wrapper: AppTooltips });
  const trigger = screen.getByRole("img", { name: "Pending" });
  const mark = trigger.querySelector('[data-slot="schedule-request-status"]')!;
  expect(mark).toHaveClass(
    "size-4",
    "shrink-0",
    "bg-warning/15",
    "text-warning"
  );
  expect(mark.querySelector(".lucide-clock")).toHaveAttribute(
    "aria-hidden",
    "true"
  );
  trigger.focus();
  expect(trigger).toHaveFocus();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Pending. Schedule details are loading."
  );
});

it.each(["applied", "inherited"] as const)(
  "omits a confirmed %s mark even while the summary is pending",
  (status) => {
    mocks.schedule = {
      connector: "example-tracker",
      source_id: "main",
      revision: 3,
      status,
    };
    render(<ConnectorHealthPane />, { wrapper: AppTooltips });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="schedule-request-status"]')
    ).toBeNull();
    expect(screen.queryByText(/inherited/i)).not.toBeInTheDocument();
  }
);

it.each(["applied", "inherited"] as const)(
  "never fetches a row status or reserves space for a verified %s summary",
  (status) => {
    mocks.summaryStatus = status;
    render(<ConnectorHealthPane />, { wrapper: AppTooltips });
    expect(mocks.reads).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="schedule-request-status"]')
    ).toBeNull();
    expect(screen.queryByText(/inherited/i)).not.toBeInTheDocument();
  }
);

it("keeps the current attention mark when the cached instance revision is older", async () => {
  mocks.schedule = {
    connector: "example-tracker",
    source_id: "main",
    revision: 2,
    status: "inherited",
  };
  render(<ConnectorHealthPane />, { wrapper: AppTooltips });
  const trigger = screen.getByRole("img", { name: "Pending" });
  await userEvent.hover(trigger);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Pending. Schedule details are loading."
  );
});

it("explains Paused while the collapsed row's schedule details load", async () => {
  mocks.summaryStatus = "paused";
  render(<ConnectorHealthPane />, { wrapper: AppTooltips });
  const chip = screen.getByRole("img", { name: "Paused" });
  await userEvent.hover(chip);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Paused. Schedule details are loading."
  );
});

it.each([
  ["pending", "Pending", false],
  ["pending", "Pending", true],
  ["paused", "Paused", false],
  ["paused", "Paused", true],
] as const)(
  "explains %s when schedule details fail to load: label %s, cached %s",
  async (status, label, cached) => {
    mocks.summaryStatus = status;
    mocks.scheduleError = true;
    if (cached)
      mocks.schedule = {
        connector: "example-tracker",
        source_id: "main",
        revision: 2,
        status: "inherited",
      };
    render(<ConnectorHealthPane />, { wrapper: AppTooltips });
    const chip = screen.getByRole("img", { name: label });
    await userEvent.hover(chip);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      `${label}. Schedule details could not be loaded.`
    );
    expect(tooltip).not.toHaveTextContent("loading");
  }
);

it("shows loading during a refetch after an error with an older cache", async () => {
  mocks.scheduleError = true;
  mocks.scheduleFetching = true;
  mocks.schedule = {
    connector: "example-tracker",
    source_id: "main",
    revision: 2,
    status: "inherited",
  };
  render(<ConnectorHealthPane />, { wrapper: AppTooltips });
  const chip = screen.getByRole("img", { name: "Pending" });
  await userEvent.hover(chip);
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip).toHaveTextContent("Pending. Schedule details are loading.");
  expect(tooltip).not.toHaveTextContent("could not be loaded");
});

it.each([false, true])(
  "shows the row's Unavailable reason with an Applied cache: %s",
  async (cached) => {
    if (cached)
      mocks.schedule = {
        connector: "example-tracker",
        source_id: "main",
        revision: 3,
        status: "applied",
      };
    mocks.summaryStatus = "inherited";
    mocks.summaryError = "live sync job identity does not match";
    render(<ConnectorHealthPane />, { wrapper: AppTooltips });
    const chip = screen.getByRole("img", { name: "Can't read" });
    await userEvent.hover(chip);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      mocks.summaryError
    );
  }
);
