// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render as renderWithoutTooltips,
  screen,
  waitFor,
  within,
  type RenderOptions,
} from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConnectorHealthSummary,
  ConnectorRun,
  ConnectorSyncHistory,
} from "@/api/connector-health-client";

function rowFor(connector: string): HTMLElement {
  const row = screen.getByRole("cell", { name: connector }).closest("tr");
  if (row === null) throw new Error(`no row for ${connector}`);
  return row;
}

function expectTooltipLines(tooltip: HTMLElement, expected: string[]): void {
  const lines = Array.from(tooltip.querySelectorAll("span"));
  expect(lines.map((line) => line.textContent)).toEqual(expected);
  for (const line of lines) {
    expect(line).toHaveClass("block");
  }
}

const mocks = vi.hoisted(() => ({
  summary: {
    data: undefined as ConnectorHealthSummary | undefined,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
  syncs: {
    data: undefined as ConnectorSyncHistory | undefined,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@/queries/connector-schedule-author", () => ({
  useConnectorScheduleAuthor: (personId: string | undefined) =>
    personId === "00000000-0000-4000-8000-000000000001"
      ? "you"
      : "another admin",
}));
vi.mock("@/queries/connector-health", () => ({
  useConnectorHealth: () => mocks.summary,
  useConnectorSyncs: () => mocks.syncs,
  useConnectorSchedule: () => ({
    data: undefined,
    isPending: false,
    isError: false,
  }),
  useWriteConnectorSchedule: () => ({ mutateAsync: vi.fn() }),
}));

import { AppTooltips, openTooltip } from "@/test/tooltip";

vi.mock("@/queries/identity-me", () => ({
  useMe: () => ({ data: undefined }),
}));

import { ConnectorHealthPane } from "./connector-health";

const TONE_VARIANT = {
  idle: "variantSecondary",
  unknown: "variantWarning",
  failing: "variantDanger",
  ok: "variantSuccess",
  active: "variantInfo",
} as const;

function expectTone(element: HTMLElement, tone: keyof typeof TONE_VARIANT) {
  expect(element).toHaveAttribute("data-tone", tone);
  expect(element.className).toContain(TONE_VARIANT[tone]);
}

const NOW = "2026-01-15T12:00:00.000Z";

it("shows Not loaded for an expanded configured row without a source id", async () => {
  mocks.summary.data = summary({
    connectors: [{ connector: "example-tracker", configured: true }],
  });
  render(<ConnectorHealthPane />);

  await userEvent.click(rowFor("example-tracker"));

  expect(screen.getByText("Not loaded")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Edit" })
  ).not.toBeInTheDocument();
});

it.each(["pending", "paused"] as const)(
  "shows only sync history for an unconfigured row with a stale %s request",
  async (status) => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "example-tracker",
          source_id: "main",
          configured: false,
          schedule: null,
          schedule_request: {
            revision: 0,
            crons: [],
            last_observation: { status, observed_at: NOW },
          },
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const row = rowFor("example-tracker");
    const nextSync = within(row).getAllByRole("cell")[2];
    expect(nextSync).toHaveTextContent(/^—$/);
    expect(within(nextSync).queryByRole("img")).not.toBeInTheDocument();
    expect(
      nextSync.querySelector('[data-slot="schedule-request-status"]')
    ).toBeNull();

    await userEvent.click(row);
    expect(
      screen.getByRole("heading", { name: "Recent syncs" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Schedule" })
    ).not.toBeInTheDocument();
  }
);

it.each(["applied", "pending", "pending"] as const)(
  "uses request crons for Next sync only for applied requests (%s)",
  (status) => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "example-tracker",
          configured: true,
          source_id: "main",
          schedule: { crons: ["0 3 * * *"], timezone: "UTC", suspended: false },
          schedule_request: {
            revision: 2,
            crons: ["*/5 * * * *"],
            last_observation: { status, observed_at: NOW },
          },
        },
      ],
    });
    render(<ConnectorHealthPane />);
    expect(rowFor("example-tracker")).toHaveTextContent(
      status === "applied" ? "in ~5 min" : "in ~15 h"
    );
  }
);
const render = (ui: ReactNode, options?: RenderOptions) =>
  renderWithoutTooltips(ui, { wrapper: AppTooltips, ...options });

function summary(
  over: Partial<ConnectorHealthSummary> = {}
): ConnectorHealthSummary {
  return {
    as_of: NOW,
    checked_at: "2026-01-15T11:59:00.000Z",
    typical_read_interval_ms: 900_000,
    history_available: true,
    connectors: [],
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mocks.summary.refetch.mockClear();
  mocks.syncs.refetch.mockClear();
  mocks.summary.isPending = false;
  mocks.summary.isError = false;
  mocks.summary.data = summary();
  mocks.syncs.isPending = false;
  mocks.syncs.isError = false;
  mocks.syncs.data = { connector: "alpha", syncs: [], window: 50 };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the next sync is captured when the row renders", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    vi.setSystemTime(NOW);
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "example-tracker",
          configured: true,
          schedule: { crons: ["0 * * * *"], timezone: "UTC", suspended: false },
          last_sync: null,
        },
      ],
    });
  });

  function forecast() {
    render(<ConnectorHealthPane />);
    return within(rowFor("example-tracker")).getByRole("button");
  }

  it("uses the render clock rather than the response time or tooltip opening time", async () => {
    mocks.summary.data!.as_of = "2026-01-15T10:00:00.000Z";
    vi.setSystemTime(new Date("2026-01-15T12:20:00.000Z"));
    const trigger = forecast();
    expect(trigger).toHaveTextContent(/^in ~40 min$/);

    vi.setSystemTime(new Date("2026-01-15T14:00:00.000Z"));
    await act(async () => {
      trigger.focus();
    });

    expect(trigger).toHaveFocus();
    expect(trigger).toHaveTextContent(/^in ~40 min$/);
    expect(screen.getByRole("tooltip")).toHaveTextContent("0 * * * *UTC");
  });

  it("does not update after 30 seconds or after the scheduled start while open", async () => {
    const openingTime = "2026-01-15T12:59:45.000Z";
    vi.setSystemTime(new Date(openingTime));
    mocks.summary.data!.as_of = openingTime;
    const trigger = forecast();

    await act(async () => {
      trigger.focus();
    });
    expect(trigger).toHaveTextContent(/^in < 1 min$/);
    expect(screen.getByRole("tooltip")).toHaveTextContent("0 * * * *UTC");

    await act(async () => {
      vi.advanceTimersByTime(29_999);
    });
    expect(trigger).toHaveTextContent(/^in < 1 min$/);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(trigger).toHaveTextContent(/^in < 1 min$/);
    expect(screen.getByRole("tooltip")).toHaveTextContent("0 * * * *UTC");
    expect(mocks.summary.refetch).not.toHaveBeenCalled();
  });

  it("keeps the render clock when reopened after time passes while closed", async () => {
    vi.setSystemTime(new Date("2026-01-15T12:20:00.000Z"));
    const trigger = forecast();

    await act(async () => {
      trigger.focus();
    });
    expect(trigger).toHaveTextContent(/^in ~40 min$/);
    expect(screen.getByRole("tooltip")).toHaveTextContent("0 * * * *UTC");

    await act(async () => {
      trigger.blur();
    });
    await act(async () => {
      vi.advanceTimersByTime((2 * 60 + 10) * 60_000);
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    await act(async () => {
      trigger.focus();
    });
    expect(trigger).toHaveTextContent(/^in ~40 min$/);
    expect(screen.getByRole("tooltip")).toHaveTextContent("0 * * * *UTC");
  });

  it("recomputes against the viewer's clock when the row renders again", () => {
    vi.setSystemTime(new Date("2026-01-15T12:20:00.000Z"));
    const view = render(<ConnectorHealthPane />);
    const trigger = within(rowFor("example-tracker")).getByRole("button");
    expect(trigger).toHaveTextContent(/^in ~40 min$/);

    vi.setSystemTime(new Date("2026-01-15T12:50:00.000Z"));
    mocks.summary.data = { ...mocks.summary.data! };
    view.rerender(<ConnectorHealthPane />);

    expect(trigger).toHaveTextContent(/^in ~10 min$/);
  });
});

describe("the pane prints what it was served", () => {
  it.each([
    ["pending", false],
    ["pending", true],
    ["pending", false],
    ["pending", true],
  ] as const)(
    "shows the %s request chip without expanding or a row request with schedule known: %s",
    (status, known) => {
      mocks.summary.data = summary({
        connectors: [
          {
            connector: "example-tracker",
            configured: true,
            source_id: "main",
            schedule: known
              ? {
                  crons: ["0 13 * * *"],
                  timezone: "UTC",
                  suspended: false,
                }
              : null,
            schedule_request: {
              crons: [],
              revision: 2,
              last_observation: { status, observed_at: NOW },
            },
          },
        ],
      });
      render(<ConnectorHealthPane />);
      const mark = within(rowFor("example-tracker")).getByRole("img", {
        name: "Pending",
      });
      expect(mark).toBeInTheDocument();
      const scheduleCell = mark.closest("td")!;
      if (known) {
        expect(within(scheduleCell).getByRole("button")).toHaveTextContent(
          "in ~1 h"
        );
      } else {
        expect(
          within(scheduleCell).queryByRole("button")
        ).not.toBeInTheDocument();
        expect(scheduleCell).toHaveTextContent("—");
      }
      expect(rowFor("example-tracker")).toHaveAttribute(
        "aria-expanded",
        "false"
      );
      const line = scheduleCell.querySelector('[data-slot="schedule-next"]');
      expect(line).toHaveClass(
        "flex",
        "items-center",
        "leading-5",
        "whitespace-nowrap"
      );
      expect(line).toContainElement(mark);
      expect(scheduleCell).toHaveClass("align-middle");
      expect(scheduleCell.querySelector(".mt-1, .h-6, .invisible")).toBeNull();
    }
  );
  it.each([undefined, "applied", "inherited"] as const)(
    "keeps one line without a reserved mark slot for %s",
    (status) => {
      mocks.summary.data = summary({
        connectors: [
          {
            connector: "example-tracker",
            configured: true,
            source_id: "main",
            schedule: {
              crons: ["0 3 * * *"],
              timezone: "UTC",
              suspended: false,
            },
            schedule_request: status
              ? {
                  crons: status === "applied" ? ["0 3 * * *"] : [],
                  revision: 2,
                  last_observation: { status, observed_at: NOW },
                }
              : undefined,
          },
        ],
      });
      render(<ConnectorHealthPane />);
      const line = rowFor("example-tracker").querySelector(
        '[data-slot="schedule-next"]'
      );
      expect(line).toHaveClass(
        "flex",
        "items-center",
        "leading-5",
        "whitespace-nowrap"
      );
      expect(line?.children).toHaveLength(1);
      expect(line?.closest("td")).toHaveClass("align-middle");
      expect(
        rowFor("example-tracker").querySelector(
          '[data-slot="schedule-request-status"]'
        )
      ).toBeNull();
      expect(
        rowFor("example-tracker").querySelector(".mt-1, .h-6, .invisible")
      ).toBeNull();
      expect(
        within(rowFor("example-tracker")).queryByRole("img")
      ).not.toBeInTheDocument();
    }
  );
  it("shows suspension and exposes its schedule on keyboard focus", async () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "example-tracker",
          configured: true,
          schedule: {
            crons: ["0 22 * * *", "0 10 * * *"],
            timezone: "UTC",
            origin: "annotation",
            suspended: true,
          },
          last_sync: null,
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const row = rowFor("example-tracker");
    const trigger = within(row).getByRole("button");
    expect(trigger).toHaveTextContent(/^Suspended$/);
    const user = userEvent.setup();
    for (let stop = 0; stop < 5 && document.activeElement !== trigger; stop++) {
      await user.tab();
    }
    expect(trigger).toHaveFocus();
    const tooltip = await screen.findByRole("tooltip");
    expectTooltipLines(tooltip, [
      "0 22 * * *",
      "0 10 * * *",
      "UTC · suspended",
      "Suspended: no run is scheduled.",
    ]);
    expect(within(tooltip).getByText("UTC · suspended")).toHaveClass(
      "text-muted-foreground"
    );
    expect(within(tooltip).getByText("0 22 * * *")).toHaveClass("font-mono");
  });

  it("keeps each sibling's next sync and schedule on its own row", async () => {
    const schedules = [
      {
        crons: ["0 5 * * *"],
        timezone: "UTC",
        origin: "annotation",
        suspended: true,
      },
      {
        crons: ["0 17 * * *"],
        timezone: "Europe/Berlin",
        origin: "descriptor",
        suspended: false,
      },
    ] as const;
    mocks.summary.data = summary({
      connectors: schedules.map((schedule, index) => ({
        connector: "example-tracker",
        tenant_id: "example-tenant",
        source_id: `source-${index}`,
        configured: true,
        schedule: { ...schedule, crons: [...schedule.crons] },
        last_sync: null,
      })),
    });
    render(<ConnectorHealthPane />);

    const rows = screen.getAllByRole("row", { expanded: false });
    expect(rows).toHaveLength(2);
    for (const [index, detail] of [
      "UTC · suspended",
      "Europe/Berlin",
    ].entries()) {
      const cell = within(rows[index]).getAllByRole("cell")[2];
      const trigger = within(cell).getByRole("button");
      expect(trigger).toHaveTextContent(
        index === 0 ? /^Suspended$/ : /^in ~4 h$/
      );
      await act(async () => {
        trigger.focus();
      });
      const tooltip = await screen.findByRole("tooltip");
      expect(within(tooltip).getByText(schedules[index].crons[0])).toHaveClass(
        "font-mono"
      );
      expect(within(tooltip).getByText(detail)).toHaveClass(
        "text-muted-foreground"
      );
      expect(
        within(tooltip).queryByText(schedules[1 - index].crons[0])
      ).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
      await act(async () => {
        trigger.blur();
      });
      await waitFor(() =>
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
      );
    }
  });

  it.each(["click", "Enter", "Space"])(
    "the schedule button leaves expansion unchanged on %s",
    async (gesture) => {
      mocks.summary.data = summary({
        connectors: [
          {
            connector: "example-tracker",
            configured: true,
            schedule: {
              crons: ["0 22 * * *"],
              timezone: "UTC",
              suspended: false,
            },
            last_sync: null,
          },
        ],
      });
      render(<ConnectorHealthPane />);

      const row = rowFor("example-tracker");
      const trigger = within(row).getByRole("button");
      const user = userEvent.setup();
      for (const expanded of [false, true]) {
        if (expanded)
          await user.click(
            within(row).getByRole("cell", { name: "example-tracker" })
          );
        trigger.focus();
        if (gesture === "click") {
          await user.click(trigger);
        } else {
          await user.keyboard(gesture === "Enter" ? "{Enter}" : " ");
        }
        expect(row).toHaveAttribute("aria-expanded", String(expanded));
      }
    }
  );

  it.each(["hover", "focus"] as const)(
    "exposes the recorded schedule on %s",
    async (gesture) => {
      mocks.summary.data = summary({
        connectors: [
          {
            connector: "example-tracker",
            configured: true,
            schedule: {
              crons: ["0 22 * * *"],
              timezone: "Europe/Sofia",
              suspended: false,
            },
            last_sync: null,
          },
        ],
      });
      render(<ConnectorHealthPane />);

      const cell = within(rowFor("example-tracker")).getAllByRole("cell")[2];
      const trigger = within(cell).getByRole("button");
      const user = userEvent.setup();
      if (gesture === "hover") {
        await user.hover(trigger);
      } else {
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
      expect(trigger).toHaveTextContent(/^in ~8 h$/);
      expect(within(tooltip).getByText("0 22 * * *")).toHaveClass("font-mono");
      expect(within(tooltip).getByText("Europe/Sofia")).toHaveClass(
        "text-muted-foreground"
      );
      expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
      expect(rowFor("example-tracker")).toHaveAttribute(
        "aria-expanded",
        "false"
      );
    }
  );
  it("shows the next sync after the instance, with each tooltip cron on its own line", async () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "example-tracker",
          configured: true,
          schedule: {
            suspended: false,
            crons: ["0 22 * * *", "0 10 * * *"],
            timezone: "Europe/Sofia",
            origin: "annotation",
          },
          last_sync: null,
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const headings = screen
      .getAllByRole("columnheader")
      .map((cell) => cell.textContent);
    expect(headings).toEqual([
      "Connector",
      "Instance",
      "Next sync",
      "State",
      "Last sync started",
      "Duration",
      "Records reported",
    ]);
    const cell = within(rowFor("example-tracker")).getAllByRole("cell")[2];
    const trigger = within(cell).getByRole("button");
    expect(trigger).toHaveTextContent(/^in ~8 h$/);
    await act(async () => {
      trigger.focus();
    });
    const tooltip = await screen.findByRole("tooltip");
    const first = within(tooltip).getByText("0 22 * * *");
    const second = within(tooltip).getByText("0 10 * * *");
    expectTooltipLines(tooltip, ["0 22 * * *", "0 10 * * *", "Europe/Sofia"]);
    expect(first).toHaveClass("font-mono");
    expect(second).toHaveClass("font-mono");
    expect(within(tooltip).getByText("Europe/Sofia")).toHaveClass(
      "text-muted-foreground"
    );
  });

  it.each([
    [null, "descriptor", "controller time"],
    [null, "default", "controller time"],
    ["UTC", null, "UTC"],
    [null, null, "controller time"],
  ] as const)(
    "prints recorded timezone %s without origin %s",
    async (timezone, origin, detail) => {
      mocks.summary.data = summary({
        connectors: [
          {
            connector: "example-tracker",
            configured: true,
            schedule: {
              crons: ["0 22 * * *"],
              timezone,
              origin,
              suspended: false,
            },
            last_sync: null,
          },
        ],
      });
      render(<ConnectorHealthPane />);

      const cell = within(rowFor("example-tracker")).getAllByRole("cell")[2];
      const trigger = within(cell).getByRole("button");
      expect(trigger).toHaveTextContent(
        timezone == null ? /^Unknown$/ : /^in ~10 h$/
      );
      await act(async () => {
        trigger.focus();
      });
      const tooltip = await screen.findByRole("tooltip");
      expect(within(tooltip).getByText(detail)).toBeInTheDocument();
      expect(tooltip.textContent).not.toMatch(/ · $/);
      expect(tooltip).not.toHaveTextContent(/descriptor|default/);
      if (timezone == null) {
        expect(tooltip).toHaveTextContent(
          "The schedule has no recorded time zone."
        );
      }
    }
  );

  it("explains an unreadable expression while preserving the recorded schedule", async () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "example-tracker",
          configured: true,
          schedule: {
            crons: ["0 22 * * *", "@every 5m"],
            timezone: "UTC",
            suspended: false,
          },
          last_sync: null,
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const trigger = within(rowFor("example-tracker")).getByRole("button");
    expect(trigger).toHaveTextContent(/^Unknown$/);
    await act(async () => {
      trigger.focus();
    });
    const tooltip = await screen.findByRole("tooltip");
    expectTooltipLines(tooltip, [
      "0 22 * * *",
      "@every 5m",
      "UTC",
      "Next run unknown: a recorded expression cannot be read.",
    ]);
    expect(within(tooltip).getByText("0 22 * * *")).toHaveClass("font-mono");
    expect(within(tooltip).getByText("@every 5m")).toHaveClass("font-mono");
    expect(within(tooltip).getByText("UTC")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
  });

  it("prints an unrecorded schedule as unknown and spans all seven columns when expanded", async () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "example-tracker",
          configured: true,
          schedule: null,
          last_sync: null,
        },
      ],
    });
    render(<ConnectorHealthPane />, { wrapper: AppTooltips });

    const cell = within(rowFor("example-tracker")).getAllByRole("cell")[2];
    expect(cell).toHaveTextContent(/^—$/);
    await userEvent.hover(within(cell).getByText("—"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(openTooltip()).toBeNull();
    expect(within(cell).queryByRole("button")).not.toBeInTheDocument();
    await userEvent.click(rowFor("example-tracker"));
    expect(
      screen.getByText(/no sync has been recorded/i).closest("td")
    ).toHaveAttribute("colspan", "7");
  });

  it("keeps the served order rather than sorting again", () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "zulu",
          configured: true,
          last_sync: { job_id: "1", status: "succeeded", started_at: NOW },
        },
        {
          connector: "alpha",
          configured: true,
          last_sync: { job_id: "9", status: "failed", started_at: NOW },
        },
        {
          connector: "mike",
          configured: true,
          last_sync: { job_id: "5", status: "running", started_at: NOW },
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const names = screen
      .getAllByRole("row", { expanded: false })
      .map((row) => row.querySelector("td")?.textContent);
    expect(names).toEqual(["zulu", "alpha", "mike"]);
  });

  it("keeps the same row expanded when the served order changes", async () => {
    const alpha = {
      connector: "alpha",
      configured: true,
      last_sync: { job_id: "1", status: "succeeded" as const, started_at: NOW },
    };
    const bravo = {
      connector: "bravo",
      configured: true,
      last_sync: { job_id: "2", status: "failed" as const, started_at: NOW },
    };
    mocks.summary.data = summary({ connectors: [alpha, bravo] });
    const { rerender } = render(<ConnectorHealthPane />);

    await userEvent.click(rowFor("alpha"));
    expect(rowFor("alpha")).toHaveAttribute("aria-expanded", "true");

    mocks.summary.data = summary({ connectors: [bravo, alpha] });
    rerender(<ConnectorHealthPane />);

    expect(rowFor("alpha")).toHaveAttribute("aria-expanded", "true");
    expect(rowFor("bravo")).toHaveAttribute("aria-expanded", "false");
  });

  it("truncates a UUID-length tenant below its source while retaining the full identity", () => {
    const tenant = "00000000-0000-4000-8000-000000000001";
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "example-tracker",
          tenant_id: tenant,
          source_id: "example-tracker-main",
          configured: true,
          last_sync: null,
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const cell = within(rowFor("example-tracker")).getAllByRole("cell")[1];
    const tenantLine = within(cell).getByText(tenant);
    const sourceLine = within(cell).getByText("example-tracker-main");
    expect(tenantLine).toHaveClass(
      "max-w-40",
      "truncate",
      "text-xs",
      "text-muted-foreground"
    );
    expect(tenantLine).toHaveAttribute("title", tenant);
    expect(sourceLine).toHaveClass("block");
    expect(sourceLine.nextElementSibling).toBe(tenantLine);
    expect(cell).toHaveAccessibleName(`${tenant} / example-tracker-main`);
  });

  it.each([
    [undefined, undefined, "—", ["—"]],
    [null, null, "—", ["—"]],
    ["", "", "—", ["—"]],
    ["acme", undefined, "acme / —", ["—", "acme"]],
    ["acme", "", "acme / —", ["—", "acme"]],
    [undefined, "main", "— / main", ["main", "—"]],
    ["", "main", "— / main", ["main", "—"]],
  ] as const)(
    "keeps missing identity values explicit for tenant %s and source %s",
    (tenant, source, label, lines) => {
      mocks.summary.data = summary({
        connectors: [
          {
            connector: "example-tracker",
            tenant_id: tenant,
            source_id: source,
            configured: true,
            last_sync: null,
          },
        ],
      });
      render(<ConnectorHealthPane />);

      const cell = within(rowFor("example-tracker")).getAllByRole("cell")[1];
      const visibleLines =
        cell.children.length === 0
          ? [cell.textContent]
          : Array.from(cell.children, (child) => child.textContent);
      expect(cell).toHaveAccessibleName(label);
      expect(visibleLines).toEqual(lines);
    }
  );

  it("gives two installations of one connector a row each", () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "claude-team",
          tenant_id: "acme",
          source_id: "claude-team-main",
          configured: true,
          last_sync: null,
        },
        {
          connector: "claude-team",
          tenant_id: "example-tenant",
          source_id: "claude-team-second",
          configured: true,
          last_sync: null,
        },
      ],
    });
    render(<ConnectorHealthPane />);

    expect(screen.getAllByRole("cell", { name: "claude-team" })).toHaveLength(
      2
    );
    for (const [source, tenant] of [
      ["claude-team-main", "acme"],
      ["claude-team-second", "example-tenant"],
    ]) {
      const sourceLine = screen.getByText(source);
      expect(sourceLine).toBeInTheDocument();
      const cell = sourceLine.closest("td")!;
      expect(within(cell).getByText(tenant)).toBeInTheDocument();
      expect(cell).toHaveAccessibleName(`${tenant} / ${source}`);
    }
  });

  it("opens one installation without opening its sibling", async () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "claude-team",
          tenant_id: "acme",
          source_id: "claude-team-main",
          configured: true,
          last_sync: null,
        },
        {
          connector: "claude-team",
          tenant_id: "acme",
          source_id: "claude-team-second",
          configured: true,
          last_sync: null,
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const rows = screen.getAllByRole("row", { expanded: false });
    await userEvent.click(rows[1]);

    const expanded = screen.getAllByRole("row", { expanded: true });
    expect(expanded).toHaveLength(1);
    const sourceLine = within(expanded[0]).getByText("claude-team-second");
    expect(sourceLine).toBeInTheDocument();
    const cell = sourceLine.closest("td")!;
    expect(within(cell).getByText("acme")).toBeInTheDocument();
    expect(cell).toHaveAccessibleName("acme / claude-team-second");
  });

  it("points two rows at two disclosures when an identity carries a separator", () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "alpha",
          tenant_id: "acme_one",
          source_id: "main",
          configured: true,
          last_sync: null,
        },
        {
          connector: "alpha",
          tenant_id: "acme",
          source_id: "one_main",
          configured: true,
          last_sync: null,
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const controls = screen
      .getAllByRole("row", { expanded: false })
      .map((row) => row.getAttribute("aria-controls"));

    expect(controls[0]).not.toBe(controls[1]);
  });

  it("prints an unmeasured number as absence, not as a zero", () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "alpha",
          tenant_id: "acme",
          source_id: "main",
          configured: true,
          schedule: {
            suspended: false,
            crons: ["0 * * * *"],
            timezone: "UTC",
            origin: "default",
          },
          last_sync: {
            job_id: "1",
            status: "running",
            started_at: null,
            duration_ms: null,
            records_reported: null,
          },
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const row = rowFor("alpha");
    expect(within(row).getAllByText("—")).toHaveLength(3);
    expect(within(row).queryByText("0")).not.toBeInTheDocument();
  });

  it("says how long a sync in flight has been going, not that it took no time", () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "alpha",
          configured: true,
          last_sync: {
            job_id: "1",
            status: "running",
            started_at: "2026-01-15T10:46:00.000Z",
            duration_ms: 0,
            records_reported: null,
          },
        },
      ],
    });
    render(<ConnectorHealthPane />);

    const row = rowFor("alpha");
    expect(within(row).getByText("1h 14m so far")).toBeInTheDocument();
    expect(within(row).queryByText("0s")).not.toBeInTheDocument();
  });

  it("says a reported zero is a zero", () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "alpha",
          configured: true,
          last_sync: {
            job_id: "1",
            status: "succeeded",
            started_at: NOW,
            duration_ms: 0,
            records_reported: 0,
          },
        },
      ],
    });
    render(<ConnectorHealthPane />);

    expect(within(rowFor("alpha")).getByText("0")).toBeInTheDocument();
  });

  it("keeps the connector list visible when managed history is unavailable", () => {
    const note = "Sync run history is unavailable.";
    mocks.summary.data = summary({
      history_read_error: note,
      connectors: [{ connector: "alpha", configured: true }],
    });
    render(<ConnectorHealthPane />);
    expect(screen.getByText(note)).toHaveAttribute("role", "alert");
    expect(rowFor("alpha")).toBeVisible();
  });

  it("says nothing has been recorded instead of implying health", () => {
    mocks.summary.data = summary({
      connectors: [],
      history_available: false,
      checked_at: null,
    });
    render(<ConnectorHealthPane />);

    expect(screen.getByText(/nothing has been read yet/i)).toBeInTheDocument();
    expect(
      screen.getByText("Sync records appear here after the first update.")
    ).toBeVisible();
    expect(
      screen.queryByText(/healthy|up to date|fine/i)
    ).not.toBeInTheDocument();
  });

  it("does not say nothing has been read when something has", () => {
    mocks.summary.data = summary({ connectors: [], history_available: true });
    render(<ConnectorHealthPane />);

    expect(screen.getByText(/last checked/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/nothing has been read/i)
    ).not.toBeInTheDocument();
    expect(screen.getByText(/reported no connector/i)).toBeInTheDocument();
  });
});

describe("the pane dates itself", () => {
  it("reports when the mover was last read", () => {
    render(<ConnectorHealthPane />);
    expect(screen.getByText(/last checked 1 min ago/i)).toBeInTheDocument();
  });

  it("announces a stopped recorder together with its consequence", () => {
    mocks.summary.data = summary({ checked_at: "2026-01-15T04:00:00.000Z" });
    render(<ConnectorHealthPane />);

    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(/recording appears to have stopped/i);
    expect(region).toHaveTextContent(/may no longer be current/i);
  });

  it("says it cannot date the page when the two clocks disagree", () => {
    mocks.summary.data = summary({ checked_at: "2026-01-16T00:00:00.000Z" });
    render(<ConnectorHealthPane />);

    expect(screen.getByRole("status")).toHaveTextContent(/cannot tell when/i);
  });
});

describe("a read that failed says so", () => {
  it("offers a retry instead of an empty table", async () => {
    mocks.summary.isError = true;
    mocks.summary.data = undefined;
    render(<ConnectorHealthPane />);

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /retry|try again/i })
    );
    expect(mocks.summary.refetch).toHaveBeenCalled();
  });

  it("waits rather than rendering an empty page while the read is in flight", () => {
    mocks.summary.isPending = true;
    mocks.summary.data = undefined;
    render(<ConnectorHealthPane />);

    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/nothing has been read/i)
    ).not.toBeInTheDocument();
  });

  it("keeps a failed window inside its own row", async () => {
    mocks.summary.data = summary({
      connectors: [{ connector: "alpha", configured: true, last_sync: null }],
    });
    mocks.syncs.isError = true;
    mocks.syncs.data = undefined;
    render(<ConnectorHealthPane />);

    await userEvent.click(rowFor("alpha"));

    expect(screen.getByRole("table")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: /retry|try again/i })
    );
    expect(mocks.syncs.refetch).toHaveBeenCalled();
  });

  it("says a connector has no recorded sync rather than showing an empty list", async () => {
    mocks.summary.data = summary({
      connectors: [{ connector: "alpha", configured: true, last_sync: null }],
    });
    mocks.syncs.data = { connector: "alpha", syncs: [], window: 50 };
    render(<ConnectorHealthPane />);

    await userEvent.click(rowFor("alpha"));

    expect(
      screen.getByText(/no sync has been recorded for this connector/i)
    ).toBeInTheDocument();
  });
});

describe("a row expands to its recent syncs", () => {
  it("sizes the sticky expanded pane to the table scroll container at every viewport", async () => {
    mocks.summary.data = summary({
      connectors: [
        { connector: "example-tracker", source_id: "main", configured: true },
      ],
    });
    render(<ConnectorHealthPane />);
    await userEvent.click(rowFor("example-tracker"));

    const table = screen.getByRole("table");
    expect(table.parentElement).toHaveClass("@container");
    const cell = document.getElementById(
      rowFor("example-tracker").getAttribute("aria-controls")!
    );
    expect(cell).toHaveClass("whitespace-normal");
    const boundary = cell!.firstElementChild!;
    expect(boundary).toHaveClass("min-w-0", "[contain:inline-size]");
    const pane = boundary.firstElementChild!;
    expect(pane).toHaveClass(
      "sticky",
      "left-4",
      "w-[calc(100cqw-2rem)]",
      "max-w-full",
      "min-w-0",
      "grid-cols-1"
    );
    for (const className of [
      "sm:static",
      "sm:w-auto",
      "lg:grid-cols-2",
      "lg:@3xl:grid-cols-2",
    ]) {
      expect(pane).not.toHaveClass(className);
    }
    expect(pane).toHaveClass("whitespace-normal", "[overflow-wrap:anywhere]");
    for (const card of pane.children) expect(card).toHaveClass("min-w-0");
  });

  it("allows the schedule card to shrink within the expanded row", async () => {
    mocks.summary.data = summary({
      connectors: [
        { connector: "example-tracker", source_id: "main", configured: true },
      ],
    });
    render(<ConnectorHealthPane />);
    await userEvent.click(rowFor("example-tracker"));

    const pane = screen.getByRole("heading", { name: "Schedule" })
      .parentElement!.parentElement!;
    expect(pane.parentElement).toHaveClass("min-w-0");
  });

  it("places the full-width schedule strip before recent syncs in the disclosure", async () => {
    mocks.summary.data = summary({
      connectors: [
        { connector: "example-tracker", source_id: "main", configured: true },
      ],
    });
    render(<ConnectorHealthPane />);
    await userEvent.click(rowFor("example-tracker"));

    const schedule = screen.getByRole("heading", { name: "Schedule" });
    const history = screen.getByRole("heading", { name: "Recent syncs" });
    expect(
      schedule.compareDocumentPosition(history) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const cell = document.getElementById(
      rowFor("example-tracker").getAttribute("aria-controls")!
    )!;
    const strip = cell.firstElementChild!.firstElementChild!;
    expect(strip).toHaveClass("grid-cols-1");
    expect(strip.children[0]).toContainElement(schedule);
    expect(strip.children[1]).toContainElement(history);
  });

  it("is operable from the keyboard and announces its state", async () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "alpha",
          configured: true,
          last_sync: {
            job_id: "1",
            status: "succeeded",
            started_at: NOW,
            duration_ms: 1_000,
            records_reported: 5,
          },
        },
      ],
    });
    mocks.syncs.data = {
      connector: "alpha",
      syncs: [
        {
          job_id: "1",
          status: "succeeded",
          started_at: NOW,
          duration_ms: 1_000,
          records_reported: 5,
        },
      ],
      window: 50,
    };
    render(<ConnectorHealthPane />);

    expect(rowFor("alpha")).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(rowFor("alpha"));

    expect(rowFor("alpha")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/recent syncs/i)).toBeInTheDocument();
  });

  it("counts recorded syncs rather than presenting the window cap as a count", async () => {
    mocks.summary.data = summary({
      connectors: [{ connector: "alpha", configured: true, last_sync: null }],
    });
    mocks.syncs.data = {
      connector: "alpha",
      syncs: [
        {
          job_id: "1",
          status: "succeeded",
          started_at: NOW,
          duration_ms: 1_000,
          records_reported: 5,
        },
      ],
      window: 50,
    };
    render(<ConnectorHealthPane />);

    await userEvent.click(rowFor("alpha"));

    expect(screen.getByText("Latest 1")).toBeInTheDocument();
  });

  it("does not take the row out of the table to make it clickable", () => {
    mocks.summary.data = summary({
      connectors: [{ connector: "alpha", configured: true, last_sync: null }],
    });
    render(<ConnectorHealthPane />);

    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(rowFor("alpha")).toHaveAttribute("aria-expanded");
  });

  it("opens the connector from anywhere in the row, not just its name", async () => {
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "alpha",
          configured: true,
          last_sync: { job_id: "1", status: "succeeded", started_at: NOW },
        },
      ],
    });
    render(<ConnectorHealthPane />);

    await userEvent.click(screen.getByText("Ready"));

    expect(rowFor("alpha")).toHaveAttribute("aria-expanded", "true");
  });

  it("opens the connector from the keyboard", async () => {
    mocks.summary.data = summary({
      connectors: [{ connector: "alpha", configured: true, last_sync: null }],
    });
    render(<ConnectorHealthPane />);

    rowFor("alpha").focus();
    await userEvent.keyboard("{Enter}");

    expect(rowFor("alpha")).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard(" ");

    expect(rowFor("alpha")).toHaveAttribute("aria-expanded", "false");
  });

  it("does not open the connector when a selection was dragged across it", async () => {
    mocks.summary.data = summary({
      connectors: [{ connector: "alpha", configured: true, last_sync: null }],
    });
    render(<ConnectorHealthPane />);

    const selection = window.getSelection();
    selection?.selectAllChildren(screen.getByRole("cell", { name: "alpha" }));

    // WORKAROUND: a userEvent pointer press collapses the selection before the click handler runs.
    fireEvent.click(rowFor("alpha"));

    expect(rowFor("alpha")).toHaveAttribute("aria-expanded", "false");
  });
});

it("names the page Connectors", () => {
  mocks.summary.data = summary({ connectors: [] });
  render(<ConnectorHealthPane />);
  expect(
    screen.getByRole("heading", { name: "Connectors", level: 1 })
  ).toBeInTheDocument();
});

describe("connector workflow runs", () => {
  const run = (index: number): ConnectorRun => ({
    sync_id: `sync-${index}`,
    status: "failed",
    started_at: new Date(Date.parse(NOW) - index * 60_000).toISOString(),
    finished_at: NOW,
    duration_ms: 15_000,
    stages: [],
  });

  const stamp = (seconds: number) =>
    new Date(Date.parse(NOW) + seconds * 1000).toISOString();

  function step(stage: string, start: number, end: number) {
    return {
      stage,
      attempt: 1,
      status: "succeeded",
      queued_at: stamp(start),
      started_at: stamp(start),
      finished_at: stamp(end),
      duration_ms: (end - start) * 1000,
    };
  }

  async function openRun(latest: ConnectorRun) {
    mocks.summary.data = summary({
      connectors: [
        { connector: "example", configured: true, latest_run: latest },
      ],
    });
    mocks.syncs.data = {
      connector: "example",
      syncs: [],
      window: 50,
      runs: [latest],
    };
    render(<ConnectorHealthPane />);
    await userEvent.click(rowFor("example"));
  }

  it("combines the working time of all six stages into four admin steps", async () => {
    await openRun({
      ...run(1),
      status: "succeeded",
      stages: [
        step("bronze", -60, -55),
        step("transform-staging", -55, -45),
        step("transform-jira-staging", -45, -30),
        step("identity-seed", -30, -27),
        step("transform-legacy", -27, -20),
        step("transform-jira-silver", -20, 0),
      ],
    });
    const rows = within(
      screen.getByRole("list", { name: "Run steps (UTC)" })
    ).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    for (const [index, [label, duration]] of [
      ["Bronze", "5s"],
      ["Silver", "25s"],
      ["Identity", "3s"],
      ["Gold", "27s"],
    ].entries()) {
      expect(within(rows[index]).getByText(label)).toBeVisible();
      expect(within(rows[index]).getByText(duration)).toBeVisible();
    }
    const summary = screen
      .getByRole("heading", { name: "Last successful sync" })
      .closest("section")!;
    expect(summary).toHaveTextContent(/Bronze5sSilver25sIdentity3sGold27s/);
  });

  it("merges overlapping waits and gaps into one Queued row per step", async () => {
    await openRun({
      ...run(1),
      status: "succeeded",
      stages: [
        step("bronze", -60, -50),
        {
          ...step("transform-staging", -30, -25),
          queued_at: stamp(-48),
          waits: [
            { kind: "lock", started_at: stamp(-48), ended_at: stamp(-37) },
            { kind: "placement", started_at: stamp(-40), ended_at: stamp(-32) },
          ],
        },
        step("transform-jira-staging", -20, -10),
        step("transform-legacy", -10, -3),
      ],
    });
    const rows = within(
      screen.getByRole("list", { name: "Run steps (UTC)" })
    ).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent(/Queued25s/);
    expect(rows[2]).toHaveTextContent("Silver");
    const queued = within(rows[1]).getByText("Queued");
    await userEvent.hover(queued);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Waiting for a lock.*Waiting for cluster capacity/s
    );
    const band = within(
      screen.getByRole("figure", { name: "Steps of the selected sync" })
    );
    expect(band.getByLabelText(/Queued · 20s/)).toBeVisible();
    const gap = band.getByLabelText("2026-01-15 11:59:35Z · Queued · 5s");
    expect(gap).toBeVisible();
    expect(band.queryByLabelText(/Queued · 3s/)).not.toBeInTheDocument();
    await userEvent.unhover(queued);
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    await userEvent.hover(gap);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /^2026-01-15 11:59:35Z · Queued · 5s$/
    );
    expect(gap).not.toHaveAccessibleDescription();
  });

  const currentRun = () =>
    within(
      screen.getByRole("heading", { name: "Current run" }).closest("section")!
    );
  const runSteps = () =>
    within(screen.getByRole("list", { name: "Run steps (UTC)" }));
  const runBand = () =>
    within(screen.getByRole("figure", { name: "Steps of the selected sync" }));

  it.each([
    [179, "idle"],
    [181, "unknown"],
  ] as const)(
    "uses the queue tone for %s minutes of waiting",
    async (minutes, tone) => {
      const queued = stamp(-minutes * 60);
      await openRun({
        ...run(1),
        status: "queued",
        started_at: queued,
        finished_at: null,
        stages: [
          { stage: "bronze", attempt: 1, status: "queued", queued_at: queued },
        ],
      });

      expectTone(within(rowFor("example")).getByText("Queued"), tone);
      expectTone(currentRun().getByText("Queued"), tone);
    }
  );

  it.each([
    ["succeeded", "Ready", "ok"],
    ["transforming", "Running", "active"],
  ] as const)(
    "renders the %s badge with its state tone",
    async (status, label, tone) => {
      await openRun({
        ...run(1),
        status,
        finished_at: status === "succeeded" ? NOW : null,
      });

      expectTone(within(rowFor("example")).getByText(label), tone);
    }
  );

  it.each([4, 7])(
    "measures the minute queued after %s hours of Bronze work",
    async (hours) => {
      const started = -hours * 3600 - 60;
      await openRun({
        ...run(1),
        status: "starting",
        started_at: stamp(started),
        finished_at: null,
        duration_ms: null,
        stages: [step("bronze", started, -60)],
      });
      const row = within(rowFor("example"));
      for (const scope of [row, currentRun()]) {
        const queued = scope.getByText("Queued");
        expectTone(queued, "idle");
        await userEvent.hover(queued);
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      }
      expect(currentRun().getByText("1m 0s")).toBeVisible();
      expect(runSteps().getByText("Queued").closest("li")).toHaveAttribute(
        "aria-current",
        "step"
      );
    }
  );

  it.each([
    ["unknown", 300, "10m 0s"],
    ["succeeded", 280, "20m 0s"],
  ] as const)(
    "uses the band’s neutral queue when Bronze is %s without a finish",
    async (status, bronzeMinutes, queuedDuration) => {
      await openRun({
        ...run(300),
        status: "queued",
        finished_at: null,
        stages: [
          {
            ...step("bronze", -300 * 60, (-300 + bronzeMinutes) * 60),
            status,
            finished_at: null,
          },
          {
            stage: "transform-staging",
            attempt: 1,
            status: "queued",
            queued_at: stamp(-600),
            waits: [{ kind: "lock", started_at: stamp(-600) }],
          },
        ],
      });
      for (const scope of [within(rowFor("example")), currentRun()]) {
        const state = scope.getByText("Queued");
        expectTone(state, "idle");
        await userEvent.hover(state);
        expect(await screen.findByRole("tooltip")).toHaveTextContent(
          /^Waiting for a lock$/
        );
        await userEvent.unhover(state);
      }
      const band = runBand().getByLabelText((label) =>
        label.endsWith(`Queued · ${queuedDuration}`)
      );
      expect(band).toHaveClass("bg-muted-foreground/45");
      expect(currentRun().getByText(queuedDuration)).toBeVisible();
      const queued = runSteps().getByText("Queued");
      expect(queued.closest("li")).toHaveTextContent(queuedDuration);
      expect(queued.closest("li")).toHaveAttribute("aria-current", "step");
      await userEvent.hover(queued);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        /^Waiting for a lock$/
      );
      expect(
        screen.queryByText("Wait exceeded three hours")
      ).not.toBeInTheDocument();
    }
  );

  it("keeps the timing segment label out of its accessible description", async () => {
    await openRun({
      ...run(1),
      status: "succeeded",
      stages: [step("transform-legacy", -60, 0)],
    });
    const segment = runBand().getByLabelText(
      "2026-01-15 11:59:00Z · Gold · 1m 0s"
    );
    await act(async () => {
      segment.focus();
    });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("2026-01-15 11:59:00Z · Gold · 1m 0s");
    expect(segment).toHaveAccessibleName("2026-01-15 11:59:00Z · Gold · 1m 0s");
    expect(segment).toHaveAccessibleDescription("Metrics computed");
  });

  it("opens a managed row by clicking its Ready badge", async () => {
    await openRun({
      ...run(1),
      status: "succeeded",
      stages: [step("transform-legacy", -60, 0)],
    });
    const row = rowFor("example");
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(within(row).getByText("Ready"));
    expect(row).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a managed row by clicking its failure reason", async () => {
    await openRun({
      ...run(1),
      stages: [
        {
          ...step("transform-legacy", -60, 0),
          status: "failed",
          reason: "pod_oom",
        },
      ],
    });
    const row = rowFor("example");
    await userEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(
      within(row).getByText("The sync exceeded its memory limit")
    );
    expect(row).toHaveAttribute("aria-expanded", "true");
  });

  it.each(["wait_warning", "queued"])(
    "announces the three-hour warning for %s",
    async (status) => {
      const started_at = stamp(-200 * 60);
      await openRun({
        ...run(1),
        status,
        started_at,
        finished_at: null,
        stages: [
          { stage: "bronze", attempt: 1, status, queued_at: started_at },
        ],
      });
      const user = userEvent.setup();
      for (const scope of [within(rowFor("example")), currentRun()]) {
        const queued = scope.getByText("Queued");
        expectTone(queued, "unknown");
        const trigger = queued.closest<HTMLElement>("[aria-describedby]")!;
        expect(trigger).toHaveTextContent(/^Queued$/);
        await user.hover(queued);
        expect(await screen.findByRole("tooltip")).toHaveTextContent(
          "Wait exceeded three hours"
        );
        expect(trigger).toHaveAccessibleDescription(
          "Wait exceeded three hours"
        );
        await user.unhover(queued);
        await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
      }
      expect(runSteps().getByText("Queued").closest("li")).toHaveTextContent(
        "3h 20m"
      );
    }
  );

  it("keeps the row open when its state badge is clicked and describes the tooltip on focus", async () => {
    await openRun({
      ...run(1),
      stages: [
        {
          ...step("transform-legacy", -60, 0),
          status: "failed",
          reason: "pod_oom",
        },
      ],
    });
    const row = rowFor("example");
    const badge = within(row).getByText("Failed · Gold");
    const trigger = badge.closest<HTMLElement>("[tabindex]")!;
    await act(async () => {
      trigger.focus();
    });
    const tooltip = await screen.findByRole("tooltip");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
    expect(trigger).toHaveAccessibleDescription(/transform-legacy.*pod_oom/);
    await userEvent.click(badge);
    expect(row).toHaveAttribute("aria-expanded", "true");
  });

  it("shows the current step and its running state in text", async () => {
    await openRun({
      ...run(1),
      status: "transforming",
      finished_at: null,
      stages: [
        step("bronze", -60, -30),
        {
          ...step("transform-staging", -30, 0),
          status: "transforming",
          finished_at: null,
        },
      ],
    });
    expect(currentRun().getByText("Silver · Running")).toBeVisible();
    expect(runSteps().getByText("Silver").closest("li")).toHaveAttribute(
      "aria-current",
      "step"
    );
  });

  it("shows a plain failure for an unfamiliar recorded reason and retains the reason for support", async () => {
    await openRun({
      ...run(1),
      stages: [
        {
          ...step("transform-legacy", -60, 0),
          status: "failed",
          reason: "dbt_compile_error",
        },
      ],
    });
    const row = within(rowFor("example"));
    expect(row.getByText("The step failed")).toBeVisible();
    expect(row.queryByText("dbt_compile_error")).not.toBeInTheDocument();
    await userEvent.hover(row.getByText("Failed · Gold"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /transform-legacy.*dbt_compile_error/
    );
  });

  it("counts overlapping Bronze attempts once and keeps a recovered run Ready", async () => {
    await openRun({
      ...run(5),
      status: "succeeded",
      stages: [
        {
          ...step("bronze", -300, -200),
          status: "failed",
          reason: "source_pod_oom",
        },
        { ...step("bronze", -250, -100), attempt: 2 },
        step("transform-legacy", -100, 0),
      ],
    });
    const bronze = runSteps().getByText("Bronze").closest("li")!;
    expect(bronze).toHaveTextContent("3m 20s");
    expect(within(bronze).getByRole("img", { name: "Complete" })).toBeVisible();
    expect(runBand().getAllByLabelText(/Bronze · /)).toHaveLength(1);
    expect(within(rowFor("example")).getByText("Ready")).toBeVisible();
  });

  it("extends a running step's band to the snapshot without a Queued tail", async () => {
    await openRun({
      ...run(10),
      status: "transforming",
      finished_at: null,
      stages: [
        step("bronze", -600, -300),
        {
          ...step("transform-staging", -300, 0),
          status: "transforming",
          finished_at: null,
          duration_ms: 255_000,
        },
      ],
    });
    expect(runBand().queryByLabelText(/Queued/)).not.toBeInTheDocument();
    expect(runBand().getByLabelText(/Silver · 5m 0s/)).toHaveStyle({
      left: "50%",
      width: "50%",
    });
    expect(runSteps().getByText("Silver").closest("li")).toHaveTextContent(
      "5m 0s"
    );
    expect(currentRun().queryByText("Queued")).not.toBeInTheDocument();
  });

  it("keeps a cancelled run terminal and ends its open step at cancellation", async () => {
    await openRun({
      ...run(10),
      status: "cancelled",
      stages: [
        step("bronze", -600, -300),
        {
          ...step("transform-staging", -300, 0),
          status: "transforming",
          finished_at: null,
          duration_ms: 255_000,
        },
      ],
    });
    expect(within(rowFor("example")).getByText("Cancelled")).toBeVisible();
    expect(screen.getByText("No active run")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "2026-01-15 11:50:00Z · Cancelled" })
    ).toBeVisible();
    const silver = runSteps().getByText("Silver").closest("li")!;
    expect(silver).not.toHaveAttribute("aria-current");
    expect(
      within(silver).getByRole("img", { name: "Cancelled" })
    ).toBeVisible();
    expect(runBand().queryByLabelText(/Queued/)).not.toBeInTheDocument();
    expect(runBand().getByLabelText(/Silver · 5m 0s/)).toBeVisible();
  });

  it("shows a queue timeout as one failed step in each view", async () => {
    const queued_at = stamp(-400 * 60);
    await openRun({
      ...run(420),
      status: "wait_timeout",
      stages: [
        step("bronze", -420 * 60, -400 * 60),
        {
          stage: "transform-staging",
          attempt: 1,
          status: "wait_timeout",
          reason: "wait_timeout",
          queued_at,
          finished_at: NOW,
          waits: [{ kind: "lock", started_at: queued_at, ended_at: NOW }],
        },
      ],
    });
    const row = within(rowFor("example"));
    expectTone(row.getByText("Failed · Silver"), "failing");
    expect(row.getByText("Waited over 6 hours")).toBeVisible();
    expect(row.queryByText("Queued")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "2026-01-15 05:00:00Z · Failed · Silver",
      })
    ).toBeVisible();
    const band = screen.getByRole("figure", {
      name: "Steps of the selected sync",
    });
    const header = within(band.closest("section")!);
    expect(header.getByText("Failed · Silver")).toBeVisible();
    expect(header.getByText("Waited over 6 hours")).toBeVisible();
    const silver = runSteps().getByText("Silver").closest("li")!;
    expect(within(silver).getByRole("img", { name: "Failed" })).toBeVisible();
    expect(
      runBand().getByRole("button", { name: "Failed · Silver" })
    ).toBeVisible();
    expect(runSteps().getByText("Queued").closest("li")).toHaveTextContent(
      "6h 40m"
    );
  });

  it("shows an unconfirmed Bronze start as a neutral queue", async () => {
    await openRun({
      ...run(5),
      status: "checking_start",
      finished_at: null,
      stages: [
        {
          stage: "bronze",
          attempt: 1,
          status: "checking_start",
          queued_at: stamp(-300),
        },
      ],
    });
    const row = within(rowFor("example"));
    expectTone(row.getByText("Queued"), "idle");
    expect(row.queryByText("Unknown")).not.toBeInTheDocument();
    const rows = runSteps().getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/Queued5m 0s/);
    expect(rows[0]).toHaveAttribute("aria-current", "step");
    expect(rows[1]).toHaveTextContent("Bronze");
  });

  it("keeps check memory failures off the page", async () => {
    await openRun({
      ...run(1),
      status: "succeeded",
      stages: [
        step("transform-legacy", -60, -10),
        {
          ...step("connector-checks", -8, -2),
          status: "failed",
          reason: "clickhouse_user_memory_limit",
        },
      ],
    });
    expect(within(rowFor("example")).getByText("Ready")).toBeVisible();
    expect(screen.queryByText(/Quality checks failed/)).not.toBeInTheDocument();
  });

  it("keeps the run ready while checks wait for cluster capacity after Gold", async () => {
    await openRun({
      ...run(1),
      status: "queued",
      finished_at: null,
      stages: [
        step("transform-legacy", -60, -10),
        {
          stage: "connector-checks",
          attempt: 1,
          status: "queued",
          queued_at: stamp(-8),
          waits: [{ kind: "placement", started_at: stamp(-8) }],
        },
      ],
    });
    const timeline = within(
      screen.getByRole("list", { name: "Run steps (UTC)" })
    );
    expect(within(rowFor("example")).getByText("Ready")).toBeVisible();
    expect(timeline.queryByText("Queued")).not.toBeInTheDocument();
  });

  it.each([
    ["transforming", "succeeded", null],
    ["succeeded", "succeeded", NOW],
    ["failed", "failed", NOW],
  ] as const)(
    "ends the run at Ready and hides %s checks",
    async (status, runStatus, end) => {
      await openRun({
        ...run(1),
        status: runStatus,
        finished_at: end,
        duration_ms: 60_000,
        stages: [
          step("transform-legacy", -60, -10),
          {
            ...step("connector-checks", -5, 0),
            status,
            finished_at: end,
            waits: [
              { kind: "placement", started_at: stamp(-8), ended_at: stamp(-5) },
            ],
          },
        ],
      });
      const row = within(rowFor("example"));
      const page = screen.getByTestId("page-manage-connector-health");
      expect(within(page).queryAllByText(/\bchecks\b/i)).toHaveLength(0);
      const accessibleText = [
        ...page.querySelectorAll("[aria-label], [aria-description], [title]"),
      ]
        .flatMap((element) =>
          ["aria-label", "aria-description", "title"].map((key) =>
            element.getAttribute(key)
          )
        )
        .join(" ");
      expect(accessibleText).not.toMatch(/\bchecks\b/i);
      expect(row.getByText("Ready")).toBeVisible();
      expect(row.getByText("50s")).toBeVisible();
      expect(screen.getByText("No active run")).toBeVisible();
      expect(
        screen.queryByText("No successful sync yet")
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "2026-01-15 11:59:00Z · Ready" })
      ).toHaveAttribute("aria-pressed", "true");
      const band = screen.getByRole("figure", {
        name: "Steps of the selected sync",
      });
      expect(within(band).getByLabelText(/Gold · 50s/)).toHaveStyle({
        width: "100%",
      });
      expect(
        within(band).queryByLabelText(/Queued|connector-checks/)
      ).not.toBeInTheDocument();
      expect(band.closest("section")).toHaveTextContent(
        "2026-01-15 11:59:00 – 11:59:50 UTC"
      );
      const timeline = within(
        screen.getByRole("list", { name: "Run steps (UTC)" })
      );
      expect(timeline.getAllByRole("listitem")).toHaveLength(1);
      expect(timeline.getByText("Gold")).toBeVisible();
    }
  );

  it.each([
    ["airbyte_launch_rejected", "Airbyte refused the sync request", "failed"],
    [
      "airbyte_launch_unconfirmed",
      "Airbyte did not confirm the sync launch",
      "starting",
    ],
    [
      "airbyte_launch_unreadable",
      "The Airbyte job list was unavailable. The sync launch is not confirmed.",
      "starting",
    ],
    [
      "airbyte_pod_too_large",
      "The Airbyte pod is too large for any eligible node",
      "failed",
    ],
    [
      "airbyte_capacity_wait_exceeded",
      "The wait for Airbyte cluster capacity reached its time limit",
      "failed",
    ],
  ] as const)(
    "shows a terminal Bronze failure for %s",
    async (reason, label, status) => {
      await openRun({
        ...run(1),
        status,
        finished_at: null,
        stages: [
          {
            stage: "bronze",
            status:
              reason === "airbyte_pod_too_large" ||
              reason === "airbyte_capacity_wait_exceeded"
                ? "failed"
                : "not_started",
            reason,
            attempt: 1,
            queued_at: stamp(-55),
            finished_at: NOW,
          },
        ],
      });
      const row = within(rowFor("example"));
      const badge = row.getByText("Failed · Bronze");
      expect(row.getByText(label)).toBeVisible();
      expect(screen.queryByText(reason)).not.toBeInTheDocument();
      expect(screen.getByText("No active run")).toBeVisible();
      const timeline = within(
        screen.getByRole("list", { name: "Run steps (UTC)" })
      );
      expect(timeline.getByRole("img", { name: "Failed" })).toBeVisible();
      expect(timeline.getByText("Bronze").closest("li")).toHaveTextContent("—");
      await userEvent.hover(badge);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        `bronze${reason}`
      );
    }
  );

  it("shows a plain Gold failure and keeps the ClickHouse error and stage in the tooltip", async () => {
    await openRun({
      ...run(1),
      stages: [
        {
          ...step("transform-jira-silver", -60, 0),
          status: "failed",
          reason: "clickhouse_query_error:47:UNKNOWN_IDENTIFIER",
        },
      ],
    });
    const row = within(rowFor("example"));
    const badge = row.getByText("Failed · Gold");
    expect(
      row.getByText("A calculation refers to an unknown field")
    ).toBeVisible();
    expect(
      row.queryByText(/UNKNOWN_IDENTIFIER|transform-jira-silver/)
    ).not.toBeInTheDocument();
    await userEvent.hover(badge);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      /transform-jira-silver.*ClickHouse reported UNKNOWN_IDENTIFIER \(code 47\)/
    );
    expect(tooltip).not.toHaveTextContent(
      "clickhouse_query_error:47:UNKNOWN_IDENTIFIER"
    );
  });

  it.each([
    { status: "loading", finished_at: null, checked_at: NOW, label: "Bronze" },
    { status: "failed", finished_at: NOW, checked_at: null, label: "Failed" },
    {
      status: "failed",
      finished_at: NOW,
      checked_at: NOW,
      label: "no longer configured",
    },
  ])(
    "shows $label for a managed row missing from inventory",
    ({ status, finished_at, checked_at, label }) => {
      mocks.summary.data = summary({
        checked_at,
        connectors: [
          {
            connector: "jira",
            configured: false,
            latest_run: { ...run(1), status, finished_at },
          },
        ],
      });
      render(<ConnectorHealthPane />);
      expect(within(rowFor("jira")).getByText(label)).toBeVisible();
    }
  );

  it("compares the active run to a success outside the window and opens distinct same-day timelines", async () => {
    const latest = {
      ...run(1),
      status: "queued",
      finished_at: null,
      duration_ms: null,
      wait_ms: 60_000,
      load_ms: 0,
      transform_ms: null,
      records_reported: 0,
      stages: [
        {
          stage: "bronze",
          attempt: 1,
          status: "queued",
          queued_at: run(1).started_at,
          waits: [
            { kind: "placement" as const, started_at: run(1).started_at },
          ],
        },
      ],
    };
    const failure = {
      ...run(2),
      stages: [
        {
          stage: "transform-jira-silver",
          attempt: 2,
          status: "failed",
          reason: "clickhouse_memory_limit",
          queued_at: "2026-01-15T11:58:00Z",
          waits: [
            {
              kind: "placement" as const,
              started_at: "2026-01-15T11:58:10Z",
              ended_at: "2026-01-15T11:58:14Z",
            },
          ],
          started_at: "2026-01-15T11:58:20Z",
          finished_at: NOW,
          duration_ms: 100_000,
        },
      ],
    };
    const lastSuccess = {
      ...run(70),
      status: "succeeded",
      finished_at: stamp(-4060),
      stages: [
        step("bronze", -4200, -4080),
        step("transform-legacy", -4080, -4060),
      ],
    };
    mocks.summary.data = summary({
      connectors: [
        {
          connector: "jira",
          configured: true,
          latest_run: latest,
          last_successful_run: lastSuccess,
          last_sync: {
            job_id: "legacy",
            status: "succeeded",
            records_reported: 99,
          },
        },
      ],
    });
    mocks.syncs.data = {
      connector: "jira",
      syncs: [],
      window: 50,
      runs: [
        latest,
        failure,
        ...Array.from({ length: 50 }, (_, i) => run(i + 3)),
      ],
    };
    render(<ConnectorHealthPane />);
    const row = rowFor("jira");
    expect(within(row).getByText("Queued")).toBeVisible();
    expect(within(row).getByText("0")).toBeVisible();
    expect(within(row).getByText("1m 0s so far")).toBeVisible();
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    await userEvent.click(row);
    const card = (heading: string) =>
      within(
        screen.getByRole("heading", { name: heading }).closest("section")!
      );
    const current = card("Current run");
    expect(current.getAllByText("Queued")).toHaveLength(1);
    expect(current.getByText("1m 0s")).toBeVisible();
    expect(current.getByText("Bronze")).toBeVisible();
    expect(current.getByText("—")).toBeVisible();
    const success = card("Last successful sync");
    expect(success.getByText("2m 0s")).toBeVisible();
    expect(success.getByText("20s")).toBeVisible();
    const history = screen.getByRole("list", { name: /status/i });
    const marks = within(history).getAllByRole("button");
    expect(marks).toHaveLength(50);
    expect(marks.at(-1)).toHaveAttribute("aria-pressed", "true");
    const rows = () =>
      within(screen.getByRole("list", { name: "Run steps (UTC)" }));
    expect(rows().getByText("Bronze")).toBeVisible();
    expect(rows().getByText("Queued").closest("li")).toHaveAttribute(
      "aria-current",
      "step"
    );
    expect(
      screen.getByRole("figure", { name: "Steps of the selected sync" })
    ).toContainElement(screen.getByLabelText(/Queued · 1m 0s/));
    await userEvent.click(
      within(history).getByRole("button", {
        name: "2026-01-15 11:58:00Z · Failed · Gold",
      })
    );
    expect(rows().getByText("Gold")).toBeVisible();
    expect(screen.getByText("ClickHouse memory limit exceeded")).toBeVisible();
    expect(rows().queryByText("Bronze")).not.toBeInTheDocument();
    const strip = within(
      screen.getByRole("figure", { name: "Steps of the selected sync" })
    );
    expect(strip.getByLabelText(/Queued · 20s/)).toHaveStyle({ left: "0%" });
    expect(strip.getByLabelText(/Gold · 1m 40s/)).toHaveStyle({
      width: "83.33333333333333%",
    });
    expect(rows().getByText("Queued").closest("li")).toHaveTextContent("20s");
    expect(rows().queryByText("Waiting")).not.toBeInTheDocument();
    expect(rows().getByText("Gold").closest("li")).toHaveTextContent("1m 40s");
  });

  it("keeps the 49 most recent historical loads alongside the first workflow", async () => {
    const latest = run(2);
    mocks.summary.data = summary({
      connectors: [{ connector: "jira", configured: true, latest_run: latest }],
    });
    mocks.syncs.data = {
      connector: "jira",
      window: 50,
      runs: [latest],
      syncs: Array.from({ length: 50 }, (_, i) => ({
        job_id: String(100 + i),
        started_at: run(i === 0 ? 1 : i + 2).started_at,
        status: "succeeded",
        records_reported: 1234 + i,
        duration_ms: 3000,
      })).reverse(),
    };
    render(<ConnectorHealthPane />);
    await userEvent.click(rowFor("jira"));
    const marks = within(
      screen.getByRole("list", { name: /status/i })
    ).getAllByRole("button");
    expect(marks).toHaveLength(50);
    expect(marks[0]).toHaveAccessibleName("2026-01-15 11:10:00Z · Ready");
    expect(marks.at(-2)).toHaveAccessibleName("2026-01-15 11:58:00Z · Failed");
    expect(marks.at(-1)).toHaveAccessibleName("2026-01-15 11:59:00Z · Ready");
    await userEvent.click(marks[0]!);
    const details = within(
      screen.getByRole("heading", { name: "Bronze (UTC)" }).closest("section")!
    );
    expect(details.getByText("1,282")).toBeVisible();
    expect(details.getByText("3s")).toBeVisible();
    expect(details.getByText("Ready")).toBeVisible();
    expect(details.queryByText("Transformations")).not.toBeInTheDocument();
  });

  it("folds recorded jobs from every Bronze attempt into their workflow by job ID", async () => {
    const latest = {
      ...run(1),
      stages: ["441", "442"].map((jobId, index) => ({
        stage: "bronze",
        attempt: index + 1,
        status: "succeeded",
        airbyte_job_id: jobId,
      })),
    };
    mocks.summary.data = summary({
      connectors: [{ connector: "jira", configured: true, latest_run: latest }],
    });
    mocks.syncs.data = {
      connector: "jira",
      window: 50,
      runs: [latest],
      syncs: ["441", "442", "443"].map((jobId) => ({
        job_id: jobId,
        started_at: latest.started_at,
        status: "succeeded",
      })),
    };
    render(<ConnectorHealthPane />);
    await userEvent.click(rowFor("jira"));
    const history = within(screen.getByRole("list", { name: /status/i }));
    expect(history.getAllByRole("button")).toHaveLength(2);
    expect(history.getByRole("button", { name: /Ready$/ })).toBeVisible();
    expect(history.getByRole("button", { name: /Failed$/ })).toBeVisible();
  });

  it("opens an empty run history before a new connector has synced", async () => {
    mocks.summary.data = summary({
      connectors: [{ connector: "jira", configured: true }],
    });
    mocks.syncs.data = { connector: "jira", syncs: [], window: 50, runs: [] };
    render(<ConnectorHealthPane />);
    await userEvent.click(rowFor("jira"));
    expect(screen.getByText("No active run")).toBeVisible();
    expect(screen.getByText("No successful sync yet")).toBeVisible();
    expect(
      screen.queryByRole("button", { pressed: true })
    ).not.toBeInTheDocument();
  });

  it("does not present a terminal or unmeasured run as in progress or successful", async () => {
    const terminal = { ...run(1), status: "wait_timeout" };
    mocks.summary.data = summary({
      connectors: [
        { connector: "github", configured: true, latest_run: terminal },
      ],
    });
    mocks.syncs.data = {
      connector: "github",
      syncs: [],
      window: 50,
      runs: [terminal],
    };
    render(<ConnectorHealthPane />);
    await userEvent.click(rowFor("github"));
    expect(screen.getByText("No active run")).toBeVisible();
    expect(screen.getByText("No successful sync yet")).toBeVisible();
    expect(screen.getByText("No recorded steps")).toBeVisible();
    const row = within(rowFor("github"));
    expectTone(row.getByText("Failed"), "failing");
    expect(row.getByText("Waited over 6 hours")).toBeVisible();
  });
});
