import { act, render, screen, waitFor } from "@testing-library/react";
import * as Sentry from "@sentry/react";
import type {
  CellAction,
  CellActionTarget,
  CellFailureReport,
  DashboardHost,
} from "@gears-frontx/frontx-dashboard-root";
import type { Dashboard as FrontxDashboard } from "@gears-frontx/frontx-dashboard-root/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dashboardWidgetPath,
  type DashboardRead,
  type DashboardWidget,
} from "@/api/custom-client";
import FrontxBoard from "@/components/custom/frontx-board";
import { queryClient } from "@/query-client";
import { wrapper } from "@/test/alerts";

const fx = vi.hoisted(() => ({
  hosts: [] as DashboardHost[],
  onFailure: undefined as ((failure: CellFailureReport) => void) | undefined,
  cellActions: undefined as
    ((target: CellActionTarget) => readonly CellAction[]) | undefined,
  parts: [{ types: [{ $id: "part" }], instances: [] }],
}));

const role = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/queries/identity-me", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/queries/identity-me")>()),
  useIsAdmin: () => ({
    isAdmin: role.isAdmin,
    isPending: false,
    isError: false,
    retry: () => {},
  }),
}));

vi.mock("@sentry/react", () => ({ captureMessage: vi.fn() }));

vi.mock("@gears-frontx/frontx-dashboard-root", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@gears-frontx/frontx-dashboard-root")
  >()),
  DashboardRoot: class {
    constructor({
      host,
      onFailure,
    }: {
      host: DashboardHost;
      onFailure: (failure: CellFailureReport) => void;
    }) {
      fx.hosts.push(host);
      fx.onFailure = onFailure;
    }
    reload() {}
  },
  Dashboard: (props: {
    dashboardId: string;
    theme: string;
    variables: Record<string, string>;
    overlayContainer: HTMLElement;
    cellActions?: (target: CellActionTarget) => readonly CellAction[];
  }) => {
    fx.cellActions = props.cellActions;
    return (
      <div
        data-testid="frontx-dashboard"
        data-dashboard={props.dashboardId}
        data-theme={props.theme}
        data-range={props.variables.range ?? ""}
        data-overlay={props.overlayContainer === document.body ? "body" : ""}
      />
    );
  },
  loadWidgetParts: vi.fn(async () => fx.parts),
}));

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock("@/api/fetch-with-auth", () => ({ fetchWithAuth }));

const WIDGETS: DashboardWidget[] = [
  {
    id: "w1",
    name: "Deploys",
    body: { type: "line", metric: "m", x: "bucket", y: "deploys" },
    clock: { field: "day", from: "metric" },
  },
];

const READ: DashboardRead = {
  name: "Board",
  body: { title: "Board", items: [{ widget: "w1" }], time_ranges: ["P7D"] },
  tags: [],
  ownerPersonId: null,
  ownerName: null,
  access: "owner",
  visibility: null,
  folders: [],
  carries: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  fetchWithAuth.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? json({ columns: ["bucket", "deploys"], rows: [["2026-10-01", 3]] })
      : json({ items: WIDGETS })
  );
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
  queryClient.clear();
  role.isAdmin = true;
  vi.mocked(Sentry.captureMessage).mockClear();
});

const runPath = (board: string) => `${dashboardWidgetPath(board, "w1")}/run`;

const runs = () =>
  fetchWithAuth.mock.calls.filter(([, init]) => init?.method === "POST");

async function hostOf(board: string, read = READ): Promise<DashboardHost> {
  render(<FrontxBoard id={board} read={read} range={undefined} />, {
    wrapper,
  });
  await screen.findByTestId("frontx-dashboard");
  return fx.hosts.at(-1)!;
}

const WITH_PROSE: DashboardRead = {
  ...READ,
  body: {
    title: "Board",
    items: [{ heading: "Delivery" }, { text: "Some words" }, { widget: "w1" }],
  },
};

// WORKAROUND: FrontX types a served instance loosely, and the board puts its dashboard first.
async function shownDashboard(host: DashboardHost): Promise<FrontxDashboard> {
  const answer = await host.loadFile(new AbortController().signal);
  const [file] = [answer].flat();
  return file.instances[0] as unknown as FrontxDashboard;
}

function actionsOf(
  dashboard: FrontxDashboard,
  widgetId: string,
  role: CellActionTarget["role"] = "cell"
): readonly CellAction[] {
  return fx.cellActions?.({ dashboardId: dashboard.id, widgetId, role }) ?? [];
}

describe("FrontxBoard", () => {
  it("draws the board with the page theme and the selected range, and follows a theme switch", async () => {
    render(<FrontxBoard id="board-b" read={READ} range="P7D" />, { wrapper });

    const dashboard = await screen.findByTestId("frontx-dashboard");
    expect(dashboard).toHaveAttribute("data-theme", "light");
    expect(dashboard).toHaveAttribute("data-range", "P7D");
    expect(dashboard).toHaveAttribute("data-overlay", "body");
    expect(dashboard.dataset.dashboard).toMatch(
      /^gts\.frontx\.dashboard\.dashboard\.dashboard\.v1~/
    );

    document.documentElement.dataset.theme = "dark";
    await waitFor(() =>
      expect(dashboard).toHaveAttribute("data-theme", "dark")
    );
  });

  it("answers a widget run with each column's position, its distinct values and the rows a table shows", async () => {
    const host = await hostOf("board-d");

    const answer = await host.request(
      {
        method: "POST",
        path: runPath("board-d"),
        body: { bucket: true, range: "P7D" },
      },
      new AbortController().signal
    );

    expect(runs()).toEqual([
      [
        runPath("board-d"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bucket: true, range: "P7D" }),
        },
      ],
    ]);
    expect(answer).toEqual({
      columns: ["bucket", "deploys"],
      rows: [["2026-10-01", 3]],
      at: { bucket: 0, deploys: 1 },
      distinct: { bucket: ["2026-10-01"], deploys: [3] },
      tableRows: [["2026-10-01", 3]],
    });
  });

  it("answers a run the page already holds without running it again", async () => {
    const host = await hostOf("board-h");
    const request = {
      method: "POST" as const,
      path: runPath("board-h"),
      body: { bucket: true, range: "P7D" },
    };

    const first = await host.request(request, new AbortController().signal);
    const again = await host.request(request, new AbortController().signal);
    await host.request(
      { ...request, body: { bucket: true, range: "P30D" } },
      new AbortController().signal
    );

    expect(again).toEqual(first);
    expect(runs()).toHaveLength(2);
  });

  it("runs a widget without a body when the board has no periods", async () => {
    const host = await hostOf("board-p");

    await host.request(
      { method: "POST", path: runPath("board-p") },
      new AbortController().signal
    );

    expect(runs()).toEqual([[runPath("board-p"), { method: "POST" }]]);
  });

  it("refuses a run that the shown board does not hold", async () => {
    const host = await hostOf("board-r");

    await expect(
      host.request(
        { method: "POST", path: runPath("another-board") },
        new AbortController().signal
      )
    ).rejects.toThrow();
    expect(runs()).toEqual([]);
  });

  it("serves the board file followed by the widget parts", async () => {
    render(<FrontxBoard id="board-e" read={READ} range={undefined} />, {
      wrapper,
    });
    await screen.findByTestId("frontx-dashboard");
    const host = fx.hosts.at(-1)!;

    const file = await host.loadFile(new AbortController().signal);

    expect(file).toEqual([
      { types: [], instances: [expect.objectContaining({ title: "Board" })] },
      ...fx.parts,
    ]);
  });

  it("runs a refused widget once more, and then rejects", async () => {
    const host = await hostOf("board-f");
    fetchWithAuth.mockImplementation(
      async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? json({ detail: "busy" }, 429)
          : json({ items: WIDGETS })
    );

    await expect(
      host.request(
        { method: "POST", path: runPath("board-f") },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ status: 429 });
    expect(runs()).toHaveLength(2);
  });

  it("answers a run that succeeds on its second try", async () => {
    const host = await hostOf("board-s");
    fetchWithAuth.mockResolvedValueOnce(json({ detail: "down" }, 500));

    await expect(
      host.request(
        { method: "POST", path: runPath("board-s") },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ rows: [["2026-10-01", 3]] });
    expect(runs()).toHaveLength(2);
  });

  it("gives an admin a Details action on a widget cell and its larger view, which opens the widget's drilldown", async () => {
    const dashboard = await shownDashboard(await hostOf("board-a", WITH_PROSE));
    const [, , cell] = dashboard.layout.cells;

    const onCell = actionsOf(dashboard, cell.widget.id);
    const onLarger = actionsOf(dashboard, cell.larger_view!.id, "larger_view");

    expect(onCell.map((action) => action.label)).toEqual(["Details"]);
    expect(onLarger.map((action) => action.label)).toEqual(["Details"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => onLarger[0].onSelect());
    expect(
      await screen.findByRole("dialog", { name: "Deploys" })
    ).toBeInTheDocument();
  });

  it("gives no action on a heading or a text cell", async () => {
    const dashboard = await shownDashboard(await hostOf("board-t", WITH_PROSE));
    const [heading, text] = dashboard.layout.cells;

    expect(actionsOf(dashboard, heading.widget.id)).toEqual([]);
    expect(actionsOf(dashboard, text.widget.id)).toEqual([]);
  });

  it("gives a viewer who is not an admin no action on a widget cell", async () => {
    role.isAdmin = false;
    const dashboard = await shownDashboard(await hostOf("board-v"));
    const [cell] = dashboard.layout.cells;

    expect(actionsOf(dashboard, cell.widget.id)).toEqual([]);
    expect(actionsOf(dashboard, cell.larger_view!.id, "larger_view")).toEqual(
      []
    );
  });

  it("reports a failed cell once with its kind, role, widget type and Insight ids, and without its message", async () => {
    const dashboard = await shownDashboard(await hostOf("board-x"));
    const [cell] = dashboard.layout.cells;
    const failure = {
      widgetType: "frontx.dashboard.widget.cartesian_chart.v1~",
      role: "larger_view",
      reason: { kind: "transform", message: "No such key: alice@example.com" },
    } as const;

    fx.onFailure!({
      ...failure,
      dashboardId: dashboard.id,
      widgetId: cell.larger_view!.id,
    });
    fx.onFailure!({
      ...failure,
      dashboardId: "gts.frontx.dashboard.dashboard.dashboard.v1~another",
      widgetId: "another-widget",
    });

    const reports = vi.mocked(Sentry.captureMessage).mock.calls;
    expect(reports).toEqual([
      [
        "A FrontX dashboard cell failed.",
        {
          level: "error",
          fingerprint: [
            "frontx-cell-failure",
            "transform",
            cell.larger_view!.id,
          ],
          tags: {
            "frontx.failure_kind": "transform",
            "frontx.role": "larger_view",
            "frontx.widget_type": failure.widgetType,
            "insight.dashboard_id": "board-x",
            "insight.widget_id": "w1",
          },
        },
      ],
      [
        "A FrontX dashboard cell failed.",
        {
          level: "error",
          fingerprint: ["frontx-cell-failure", "transform", "another-widget"],
          tags: {
            "frontx.failure_kind": "transform",
            "frontx.role": "larger_view",
            "frontx.widget_type": failure.widgetType,
          },
        },
      ],
    ]);
    expect(JSON.stringify(reports)).not.toContain("alice@example.com");
  });

  it("says so when the widgets do not load", async () => {
    fetchWithAuth.mockResolvedValue(json({ detail: "nope" }, 500));
    render(<FrontxBoard id="board-g" read={READ} range={undefined} />, {
      wrapper,
    });

    expect(
      await screen.findByRole("status", { name: "nope" })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("frontx-dashboard")).not.toBeInTheDocument();
  });
});
