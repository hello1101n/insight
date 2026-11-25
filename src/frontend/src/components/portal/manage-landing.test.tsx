// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const viewer = vi.hoisted(() => ({
  admin: { isAdmin: false, isPending: false, isError: false, retry: () => undefined },
}));

vi.mock("@/queries/identity-me", () => ({
  useIsAdmin: () => viewer.admin,
}));

const nav = vi.hoisted(() => ({ planned: [] as string[] }));

vi.mock("@/lib/portal/nav-policy", async (orig) => {
  const actual = await orig<typeof import("@/lib/portal/nav-policy")>();
  return {
    ...actual,
    navPolicy: () => ({
      hide: actual.EMPTY_NAV_PATHS,
      planned: actual.parseNavPaths(nav.planned, "planned"),
    }),
  };
});

vi.mock("@tanstack/react-router", () => ({
  Navigate: ({
    to,
    params,
    search,
  }: {
    to: string;
    params?: Record<string, string>;
    search?: unknown;
  }) => (
    <div
      data-testid="navigate"
      data-to={to}
      data-surface={params?.surface ?? ""}
      data-search={String(search)}
    />
  ),
}));

import { ManageLanding } from "./manage-landing";

beforeEach(() => {
  viewer.admin = { isAdmin: false, isPending: false, isError: false, retry: () => undefined };
  nav.planned = [];
});

describe("ManageLanding", () => {
  it("waits for the admin check before it picks a surface", () => {
    viewer.admin = { ...viewer.admin, isPending: true };
    render(<ManageLanding />);

    expect(screen.getByTestId("manage-landing-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
  });

  it("sends an admin to Connectors", () => {
    viewer.admin = { ...viewer.admin, isAdmin: true };
    render(<ManageLanding />);

    const target = screen.getByTestId("navigate");
    expect(target).toHaveAttribute("data-to", "/manage/$surface");
    expect(target).toHaveAttribute("data-surface", "connectors");
  });

  it("sends a non-admin to the first surface their pane lists", () => {
    render(<ManageLanding />);

    expect(screen.getByTestId("navigate")).toHaveAttribute("data-surface", "assistant");
  });

  it("returns home with the current search when the pane lists nothing to open", () => {
    nav.planned = ["zone:manage/item:ai-assistant", "zone:manage/item:whats-new"];
    render(<ManageLanding />);

    const target = screen.getByTestId("navigate");
    expect(target).toHaveAttribute("data-to", "/");
    expect(target).toHaveAttribute("data-search", "true");
  });
});
