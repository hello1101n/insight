import { render, screen, waitFor } from "@testing-library/react";
import type { DashboardHost } from "@gears-frontx/frontx-dashboard-root";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardRead, DashboardWidget } from "@/api/custom-client";
import FrontxBoardPage from "@/components/custom/frontx-board";
import { wrapper } from "@/test/alerts";

const fx = vi.hoisted(() => ({
  hosts: [] as DashboardHost[],
  parts: [{ part: "widget part" }],
}));

vi.mock("@gears-frontx/frontx-dashboard-root", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@gears-frontx/frontx-dashboard-root")
  >()),
  DashboardRoot: class {
    constructor({ host }: { host: DashboardHost }) {
      fx.hosts.push(host);
    }
  },
  Dashboard: (props: {
    dashboardId: string;
    theme: string;
    variables: Record<string, string>;
  }) => (
    <div
      data-testid="frontx-dashboard"
      data-dashboard={props.dashboardId}
      data-theme={props.theme}
      data-range={props.variables.range ?? ""}
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

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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
  vi.unstubAllEnvs();
  delete document.documentElement.dataset.theme;
});

describe("FrontxBoardPage", () => {
  it("names the variable to set when the widget bundles are not served", () => {
    render(<FrontxBoardPage id="board-a" read={READ} range={undefined} />, {
      wrapper,
    });

    expect(
      screen.getByText(/FRONTX_WIDGETS_DIR is not set/)
    ).toBeInTheDocument();
    expect(screen.queryByTestId("frontx-dashboard")).not.toBeInTheDocument();
  });

  it("draws the board with the page theme and the selected range, and follows a theme switch", async () => {
    vi.stubEnv("VITE_FRONTX_WIDGETS_SET", "true");
    render(<FrontxBoardPage id="board-b" read={READ} range="P7D" />, {
      wrapper,
    });

    const dashboard = await screen.findByTestId("frontx-dashboard");
    expect(dashboard).toHaveAttribute("data-theme", "light");
    expect(dashboard).toHaveAttribute("data-range", "P7D");
    expect(dashboard.dataset.dashboard).toMatch(/~/);

    document.documentElement.dataset.theme = "dark";
    await waitFor(() =>
      expect(dashboard).toHaveAttribute("data-theme", "dark")
    );
  });

  it("keeps one root for a board it already drew", async () => {
    vi.stubEnv("VITE_FRONTX_WIDGETS_SET", "true");
    const before = fx.hosts.length;
    const first = render(
      <FrontxBoardPage id="board-c" read={READ} range={undefined} />,
      { wrapper }
    );
    await screen.findByTestId("frontx-dashboard");
    first.unmount();

    render(<FrontxBoardPage id="board-c" read={READ} range={undefined} />, {
      wrapper,
    });
    await screen.findByTestId("frontx-dashboard");

    expect(fx.hosts.length - before).toBe(1);
  });

  it("answers a data request through fetchWithAuth and adds each column's position", async () => {
    vi.stubEnv("VITE_FRONTX_WIDGETS_SET", "true");
    render(<FrontxBoardPage id="board-d" read={READ} range={undefined} />, {
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
    expect(answer).toMatchObject({
      at: { bucket: 0, deploys: 1 },
      rows: [["2026-10-01", 3]],
    });

    const file = await host.loadFile(signal);
    expect(file).toEqual([
      expect.objectContaining({ instances: expect.any(Array) }),
      ...fx.parts,
    ]);
  });
});
