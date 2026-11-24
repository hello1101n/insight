import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardRead, DashboardWidget } from "@/api/custom-client";
import FrontxBoard from "@/components/custom/frontx-board";
import { wrapper } from "@/test/alerts";

const fx = vi.hoisted(() => ({ roots: 0 }));

vi.mock("@gears-frontx/frontx-dashboard-root", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("@gears-frontx/frontx-dashboard-root")
    >();
  return {
    ...real,
    DashboardRoot: class extends real.DashboardRoot {
      constructor(
        ...options: ConstructorParameters<typeof real.DashboardRoot>
      ) {
        super(...options);
        fx.roots += 1;
      }
    },
    loadWidgetParts: vi.fn(async () => []),
  };
});

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock("@/api/fetch-with-auth", () => ({ fetchWithAuth }));

const WIDGETS: DashboardWidget[] = [
  {
    id: "w1",
    name: "Deploys",
    body: { type: "line", metric: "m", x: "bucket", y: "deploys" },
  },
  {
    id: "w2",
    name: "Lead time",
    body: { type: "line", metric: "m", x: "bucket", y: "hours" },
  },
];

const readOf = (widgets: string[]): DashboardRead => ({
  name: "Board",
  body: { title: "Board", items: widgets.map((widget) => ({ widget })) },
  tags: [],
  ownerPersonId: null,
  ownerName: null,
  access: "owner",
  visibility: null,
  folders: [],
  carries: false,
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  fetchWithAuth.mockImplementation(
    async () =>
      new Response(JSON.stringify({ items: WIDGETS }), {
        headers: { "Content-Type": "application/json" },
      })
  );
});

describe("FrontxBoard on the FrontX runtime", () => {
  it("shows an edited board and another board without a page reload, on one root", async () => {
    const view = render(
      <FrontxBoard id="board-a" read={readOf(["w1"])} range={undefined} />,
      { wrapper }
    );
    expect(
      await screen.findByText("Deploys", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(screen.queryByText("Lead time")).not.toBeInTheDocument();

    view.rerender(
      <FrontxBoard id="board-a" read={readOf(["w1", "w2"])} range={undefined} />
    );
    expect(
      await screen.findByText("Lead time", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(screen.getByText("Deploys")).toBeInTheDocument();

    view.rerender(
      <FrontxBoard id="board-b" read={readOf(["w2"])} range={undefined} />
    );
    await waitFor(
      () => expect(screen.queryByText("Deploys")).not.toBeInTheDocument(),
      { timeout: 5000 }
    );
    expect(
      await screen.findByText("Lead time", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    view.unmount();

    render(
      <FrontxBoard id="board-b" read={readOf(["w2"])} range={undefined} />,
      { wrapper }
    );
    expect(
      await screen.findByText("Lead time", {}, { timeout: 5000 })
    ).toBeInTheDocument();
    expect(fx.roots).toBe(1);
  }, 20_000);
});
