import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

import type {
  ConnectorRun,
  ConnectorSyncHistory as History,
  SyncFact,
} from "@/api/connector-health-client";

const mocks = vi.hoisted(() => ({ data: undefined as History | undefined }));
vi.mock("@/queries/connector-health", () => ({
  useConnectorSyncs: () => ({
    data: mocks.data,
    isPending: false,
    isError: false,
  }),
}));

import { AppTooltips } from "@/test/tooltip";

import { ConnectorSyncHistory } from "./connector-sync-history";

const NOW = "2026-01-15T12:00:00Z";
const instance = { connector: "example-tracker", source_id: "main" };

function runs(count: number): SyncFact[] {
  const now = new Date(NOW).getTime();
  return Array.from({ length: count }, (_, index) => ({
    job_id: `example-run-${index}`,
    status: "succeeded",
    started_at: new Date(now - index * 60_000).toISOString(),
    duration_ms: 1_000,
    records_reported: index,
  }));
}

function history(syncs: SyncFact[]) {
  mocks.data = { ...instance, syncs, window: 50 };
  return render(
    <AppTooltips>
      <ConnectorSyncHistory instance={instance} asOf={NOW} />
    </AppTooltips>
  );
}

beforeEach(() => {
  mocks.data = undefined;
});

it("labels every status cell and summarizes only finished outcomes", () => {
  const statuses = [
    "succeeded",
    "failed",
    "incomplete",
    "cancelled",
    "pending",
    "running",
    "unknown",
    "future-status",
  ];
  history(
    runs(statuses.length).map((sync, index) => ({
      ...sync,
      status: statuses[index],
    }))
  );

  const strip = screen.getByRole("list", {
    name: "Recorded sync statuses, newest on the right",
  });
  const cells = within(strip).getAllByRole("listitem");
  const labels = [
    "Ready",
    "sync failed",
    "sync incomplete",
    "sync cancelled",
    "queued",
    "syncing",
    "state unknown",
    "state unknown",
  ];
  expect(cells).toHaveLength(statuses.length);
  for (const [index, cell] of cells.entries()) {
    expect(cell).toHaveAccessibleName(
      new RegExp(
        `^Run ${statuses.length - index}: ${labels[statuses.length - index - 1]}, started `
      )
    );
    expect(cell).toHaveAttribute("tabindex", "-1");
    expect(cell).toBeEmptyDOMElement();
  }
  expect(cells[7]).toHaveClass("bg-success");
  expect(cells[6]).toHaveClass("bg-destructive");
  expect(cells[3]).toHaveClass("bg-primary");
  expect(cells[1]).toHaveClass("bg-warning");
  expect(screen.getByText("25% succeeded")).toBeInTheDocument();
});

it("summarizes all fifty runs while the table defaults to five aligned rows", () => {
  const syncs = runs(50);
  syncs[49].status = "failed";
  history(syncs);

  expect(
    within(screen.getByRole("list")).getAllByRole("listitem")
  ).toHaveLength(50);
  expect(screen.getByText("98% succeeded")).toBeInTheDocument();
  const table = screen.getByRole("table", { name: "Recent syncs" });
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent)
  ).toEqual(["Status", "Started (UTC)", "Duration", "Records"]);
  expect(within(table).getAllByRole("row")).toHaveLength(6);
  expect(table).toHaveClass("table-fixed", "w-full");
  expect(table.parentElement).toBe(
    screen.getByRole("region", { name: "Recent syncs" })
  );
  expect(within(table).queryByText("sync failed")).not.toBeInTheDocument();
});

it("pages through history from the keyboard without expanding the table", async () => {
  history(runs(11));
  const table = within(screen.getByRole("table", { name: "Recent syncs" }));
  const newer = screen.getByRole("button", { name: "Newer runs" });
  const older = screen.getByRole("button", { name: "Older runs" });
  expect(newer).toBeDisabled();
  expect(screen.getByText("1–5 of 11")).toBeVisible();
  older.focus();
  await userEvent.keyboard("{Enter}");
  expect(table.getAllByRole("row")).toHaveLength(6);
  expect(screen.getByText("6–10 of 11")).toBeVisible();
  expect(older).toHaveFocus();
  await userEvent.keyboard(" ");
  expect(table.getAllByRole("row")).toHaveLength(2);
  expect(screen.getByText("11 of 11")).toBeVisible();
  expect(older).toBeDisabled();
  await userEvent.click(newer);
  expect(screen.getByText("6–10 of 11")).toBeVisible();
});

it("selects a run from the status strip and shows its page", async () => {
  const recordedRuns = runs(12).map(
    ({ job_id, started_at, ...sync }): ConnectorRun => ({
      ...sync,
      sync_id: job_id,
      started_at: started_at!,
      stages: [],
    })
  );
  mocks.data = { ...instance, runs: recordedRuns, syncs: [], window: 50 };
  render(
    <AppTooltips>
      <ConnectorSyncHistory instance={instance} asOf={NOW} />
    </AppTooltips>
  );

  const strip = screen.getByRole("list", {
    name: "Recorded sync statuses, newest on the right",
  });
  const older = within(strip).getByRole("button", { name: /11:49:00/ });
  await userEvent.click(older);

  expect(older).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("11–12 of 12")).toBeVisible();
  expect(
    within(screen.getByRole("region", { name: "Selected run" })).getByText(
      /11:49:00/
    )
  ).toBeVisible();

  const newer = within(strip).getByRole("button", { name: /12:00:00/ });
  newer.focus();
  await userEvent.keyboard("{Enter}");

  expect(newer).toHaveAttribute("aria-pressed", "true");
  expect(older).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByText("1–5 of 12")).toBeVisible();
});

it.each([
  [0, null],
  [7, "Latest 7"],
  [10, "Latest 10"],
  [50, "Latest 50"],
] as const)(
  "counts the available records honestly for %s runs",
  (count, heading) => {
    history(runs(count));
    expect(
      screen.getByRole("heading", { name: "Recent syncs" })
    ).toBeInTheDocument();
    if (heading) expect(screen.getByText(heading)).toBeInTheDocument();
    else expect(screen.queryByText("Latest 0")).not.toBeInTheDocument();
    if (count <= 5)
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    if (count === 0) {
      expect(
        screen.getByText("No sync has been recorded for this connector.")
      ).toBeInTheDocument();
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
    }
  }
);

it("shows UTC starts and preserves unfinished durations, missing counts and zero", () => {
  const syncs = runs(3);
  syncs[0].status = "running";
  syncs[0].started_at = new Date(
    new Date(NOW).getTime() - 120_000
  ).toISOString();
  syncs[1].started_at = null;
  syncs[1].duration_ms = null;
  syncs[1].records_reported = null;
  history(syncs);

  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  expect(within(rows[0]).getAllByRole("cell")[1]).toHaveTextContent(
    "15 Jan 2026 · 11:58:00"
  );
  expect(within(rows[0]).getAllByRole("cell")[2]).toHaveTextContent(
    "2m 0s so far"
  );
  expect(within(rows[0]).getAllByRole("cell")[3]).toHaveTextContent(/^0$/);
  expect(within(rows[1]).getAllByRole("cell")[1]).toHaveTextContent("—");
  expect(within(rows[1]).getAllByRole("cell")[2]).toHaveTextContent("—");
  expect(within(rows[1]).getAllByRole("cell")[3]).toHaveTextContent(
    "means the mover reported no count, not a count of zero"
  );
});

it("keeps the status strip on one line and lets the heading and totals wrap", () => {
  history(runs(11));
  const heading = screen.getByRole("heading", { name: "Recent syncs" });
  const header = heading.parentElement!;
  const strip = within(header).getByRole("list");
  expect(header).toHaveClass("flex", "flex-wrap", "min-w-0", "items-center");
  expect(strip).toHaveClass("grid", "w-full", "min-w-0");
  expect(strip).toHaveStyle({
    gridTemplateColumns: "repeat(50, minmax(0, 1fr))",
  });
  expect(within(strip).getAllByRole("listitem")).toHaveLength(11);
  for (const bar of within(strip).getAllByRole("listitem")) {
    expect(bar).toBeEmptyDOMElement();
    expect(bar).toHaveClass(
      "min-w-0",
      "h-3",
      "first:rounded-l-full",
      "last:rounded-r-full"
    );
  }
  expect(within(header).getByText("100% succeeded")).toBeInTheDocument();
  expect(within(header).getByText("Latest 11")).toHaveClass("ml-auto");
  expect(Array.from(header.children)).toEqual([
    heading,
    strip,
    screen.getByText("100% succeeded").parentElement,
    screen.getByText("Latest 11"),
  ]);
});

it("places the newest run on the right with status and UTC start in each label and tooltip", async () => {
  const syncs = runs(3);
  syncs[0].status = "failed";
  history(syncs);
  const bars = within(screen.getByRole("list")).getAllByRole("listitem");
  const labels = [
    "Run 3: Ready, started 15 Jan 2026 · 11:58:00",
    "Run 2: Ready, started 15 Jan 2026 · 11:59:00",
    "Run 1: sync failed, started 15 Jan 2026 · 12:00:00",
  ];
  for (const [index, bar] of bars.entries()) {
    expect(bar).toHaveAccessibleName(labels[index]);
    await userEvent.hover(bar);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(labels[index]);
    await userEvent.unhover(bar);
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
    );
  }
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  expect(within(rows[0]).getByText("sync failed")).toBeInTheDocument();
});

it("wraps headers and uses proportional columns within the full-width table", () => {
  history(runs(3));
  const table = screen.getByRole("table", { name: "Recent syncs" });
  expect(table).toHaveClass("w-full", "max-w-full", "table-fixed");
  expect(table.querySelector("thead")).toHaveClass(
    "whitespace-normal",
    "[overflow-wrap:anywhere]",
    "[word-break:normal]"
  );
  expect(
    within(table).getByRole("columnheader", { name: "Started (UTC)" })
  ).toHaveClass("whitespace-normal");
  const columns = table.querySelectorAll("col");
  expect(columns[0]).toHaveClass("w-[23%]", "sm:w-1/4");
  expect(columns[1]).toHaveClass("w-[33%]", "sm:w-2/5");
  expect(columns[1]).not.toHaveClass("w-2/5");
  expect(columns[2]).toHaveClass("w-[23%]", "sm:w-1/5");
  expect(columns[3]).toHaveClass("w-[21%]", "sm:w-[15%]");
  expect(table.parentElement).toHaveClass(
    "min-w-0",
    "max-w-full",
    "whitespace-normal",
    "[overflow-wrap:anywhere]"
  );
  expect(table.parentElement).toBe(
    screen.getByRole("region", { name: "Recent syncs" })
  );
});

it("keeps UTC dates and clocks in the history cells and bar tooltips across midnight", () => {
  const syncs = runs(2);
  syncs[0].started_at = "2026-01-15T23:30:00Z";
  syncs[1].started_at = "2026-01-15T13:30:00+02:00";
  const { container } = history(syncs);
  const cells = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  expect(within(cells[0]).getAllByRole("cell")[1]).toHaveTextContent(
    /^15 Jan 2026 · 23:30:00$/
  );
  expect(within(cells[1]).getAllByRole("cell")[1]).toHaveTextContent(
    /^15 Jan 2026 · 11:30:00$/
  );
  expect(cells[1].querySelector("time")).toHaveAttribute(
    "datetime",
    "2026-01-15T11:30:00.000Z"
  );
  expect(cells[1].querySelector("time")).toHaveAttribute(
    "title",
    "2026-01-15T11:30:00.000Z"
  );
  const bars = within(screen.getByRole("list")).getAllByRole("listitem");
  expect(bars[0]).toHaveAttribute(
    "aria-label",
    "Run 2: Ready, started 15 Jan 2026 · 11:30:00"
  );
  expect(bars[1]).toHaveAccessibleName(
    "Run 1: Ready, started 15 Jan 2026 · 23:30:00"
  );
  expect(container.textContent).not.toMatch(/your time|01:30|13:30/);
  for (const bar of bars)
    expect(bar.getAttribute("aria-label")).not.toMatch(/your time|01:30|13:30/);
});

it.each([
  [
    [
      "succeeded",
      "succeeded",
      "failed",
      "running",
      "pending",
      "unknown",
      "future-status",
    ],
    "67% succeeded",
    "2 of 3 finished syncs succeeded, 1 failed",
  ],
  [
    ["succeeded", "failed", "cancelled", "running"],
    "33% succeeded",
    "1 of 3 finished syncs succeeded, 2 failed",
  ],
  [
    ["cancelled", "incomplete"],
    "0% succeeded",
    "0 of 2 finished syncs succeeded, 2 failed",
  ],
  [
    [
      "succeeded",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ],
    "13% succeeded",
    "1 of 8 finished syncs succeeded, 7 failed",
  ],
] as const)(
  "reveals and describes exact finished counts on keyboard focus for %j",
  async (statuses, share, counts) => {
    history(
      runs(statuses.length).map((sync, index) => ({
        ...sync,
        status: statuses[index],
      }))
    );
    const summary = screen.getByText(share);
    await userEvent.tab();
    const trigger = summary.parentElement!;
    expect(trigger).toHaveFocus();
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toBeVisible();
    expect(tooltip).toHaveTextContent(counts);
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
    expect(trigger).toHaveAccessibleDescription(counts);
  }
);

it("shows only the succeeded share beside the strip", () => {
  history(
    runs(50).map((sync, index) => ({
      ...sync,
      status: index < 3 ? "failed" : "succeeded",
    }))
  );

  expect(screen.queryByText(/% failed/)).not.toBeInTheDocument();
  expect(screen.getByText("94% succeeded")).toBeInTheDocument();
});

it.each([
  { statuses: [] },
  { statuses: ["running", "pending", "unknown", "future-status"] },
])("omits the share without a final state: $statuses", ({ statuses }) => {
  history(
    runs(statuses.length).map((sync, index) => ({
      ...sync,
      status: statuses[index],
    }))
  );
  expect(screen.queryByText(/% succeeded/)).not.toBeInTheDocument();
});
