// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const viewer = vi.hoisted(() => ({
  admin: { isAdmin: false, isPending: false, isError: false, retry: () => undefined },
  canManagePreviews: false,
}));

vi.mock("@/queries/identity-me", () => ({
  useIsAdmin: () => viewer.admin,
}));

vi.mock("@/queries/previews", () => ({
  usePreviewsGate: () => viewer.canManagePreviews,
}));

vi.mock("@tanstack/react-router", () => ({
  Navigate: ({ to, params }: { to: string; params?: Record<string, string> }) => (
    <div data-testid="navigate" data-to={to} data-surface={params?.surface ?? ""} />
  ),
}));

import { ManageLanding } from "./manage-landing";

beforeEach(() => {
  viewer.admin = { isAdmin: false, isPending: false, isError: false, retry: () => undefined };
  viewer.canManagePreviews = false;
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
});
