import { render, screen, waitFor } from "@testing-library/react";
import type { DashboardHost } from "@gears-frontx/frontx-dashboard-root";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardRead, DashboardWidget } from "@/api/custom-client";
import FrontxBoard from "@/components/custom/frontx-board";
import { wrapper } from "@/test/alerts";

const fx = vi.hoisted(() => ({
  hosts: [] as DashboardHost[],
  parts: [{ types: [{ $id: "part" }], instances: [] }],
}));

vi.mock("@gears-frontx/frontx-dashboard-root", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@gears-frontx/frontx-dashboard-root")
  >()),
  DashboardRoot: class {
    constructor({ host }: { host: DashboardHost }) {
      fx.hosts.push(host);
    }
    reload() {}
  },
  Dashboard: (props: {
    dashboardId: string;
    theme: string;
    variables: Record<string, string>;
    overlayContainer: HTMLElement;
  }) => (
    <div
      data-testid="frontx-dashboard"
      data-dashboard={props.dashboardId}
      data-theme={props.theme}
      data-range={props.variables.range ?? ""}
      data-overlay={props.overlayContainer === document.body ? "body" : ""}
    />
  ),
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
  fetchWithAuth.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? json({ columns: ["bucket", "deploys"], rows: [["2026-10-01", 3]] })
      : json({ items: WIDGETS })
  );
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

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

  it("answers a data request through fetchWithAuth with each column's position, its distinct values and the rows a table shows", async () => {
    render(<FrontxBoard id="board-d" read={READ} range={undefined} />, {
      wrapper,
    });
    await screen.findByTestId("frontx-dashboard");
    const host = fx.hosts.at(-1)!;
    const signal = new AbortController().signal;

    const answer = await host.request(
      { method: "POST", path: "/run", body: { bucket: true } },
      signal
    );

    expect(fetchWithAuth).toHaveBeenCalledWith("/run", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bucket: true }),
    });
    expect(answer).toEqual({
      columns: ["bucket", "deploys"],
      rows: [["2026-10-01", 3]],
      at: { bucket: 0, deploys: 1 },
      distinct: { bucket: ["2026-10-01"], deploys: [3] },
      tableRows: [["2026-10-01", 3]],
    });

    await host.request({ method: "POST", path: "/plain" }, signal);
    expect(fetchWithAuth).toHaveBeenLastCalledWith("/plain", {
      method: "POST",
      signal,
    });
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

  it("rejects a data request the service refuses", async () => {
    render(<FrontxBoard id="board-f" read={READ} range={undefined} />, {
      wrapper,
    });
    await screen.findByTestId("frontx-dashboard");
    fetchWithAuth.mockResolvedValueOnce(json({ detail: "busy" }, 429));

    await expect(
      fx.hosts
        .at(-1)!
        .request({ method: "POST", path: "/run" }, new AbortController().signal)
    ).rejects.toMatchObject({ status: 429 });
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
