// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "@/i18n";
import { resolveText } from "@/i18n/localized-text";

const adminGate = vi.hoisted(() => ({
  value: {
    isAdmin: false,
    isPending: false,
    isError: false,
    retry: () => undefined,
  },
}));
vi.mock("@/queries/identity-me", () => ({
  useIsAdmin: () => adminGate.value,
}));

vi.mock("@/components/portal/identities-view", () => ({
  IdentitiesView: () => <div data-testid="identities-view" />,
}));

vi.mock("@/components/portal/api-tokens-view", () => ({
  ApiTokensView: () => <div data-testid="api-tokens-view" />,
}));

vi.mock("@/components/portal/connector-health", () => ({
  ConnectorHealthPane: () => <div data-testid="connector-health-pane" />,
}));

import { MANAGE_ITEMS as MANAGE_ITEMS_WITH_KEYS } from "@/lib/portal/nav-model";

const MANAGE_ITEMS = MANAGE_ITEMS_WITH_KEYS.map((item) => ({
  ...item,
  label: resolveText(i18n.t, item.label),
}));

import { ManageView } from "./manage-view";

beforeEach(() => {
  adminGate.value = {
    isAdmin: false,
    isPending: false,
    isError: false,
    retry: () => undefined,
  };
});

describe("Manage · What's new", () => {
  it("renders the release notes without the legacy screen's own header", () => {
    render(<ManageView item="whats-new" />);

    expect(screen.getByText("Insight · What's new")).toBeInTheDocument();
    expect(screen.getByText("Metrics view")).toBeInTheDocument();
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });
});

describe("Manage · Connectors", () => {
  it("is instance-wide, so a non-admin is refused rather than shown an empty page", () => {
    adminGate.value = { ...adminGate.value, isAdmin: false };
    render(<ManageView item="connector-health" />);

    expect(
      screen.queryByTestId("connector-health-pane")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("opens for an operator", () => {
    adminGate.value = { ...adminGate.value, isAdmin: true };
    render(<ManageView item="connector-health" />);

    expect(screen.getByTestId("connector-health-pane")).toBeInTheDocument();
  });

  it("no longer offers the pane it replaced", () => {
    expect(MANAGE_ITEMS.map((entry) => entry.id)).toContain("connector-health");
    expect(MANAGE_ITEMS.map((entry) => entry.id)).not.toContain("data-health");
  });
});

describe("Manage · API tokens", () => {
  it("refuses a non-admin, since only an admin creates or removes tokens", () => {
    render(<ManageView item="api-tokens" />);

    expect(screen.queryByTestId("api-tokens-view")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("opens for an admin", () => {
    adminGate.value = { ...adminGate.value, isAdmin: true };
    render(<ManageView item="api-tokens" />);

    expect(screen.getByTestId("api-tokens-view")).toBeInTheDocument();
  });
});

describe("Manage · unwired items", () => {
  it("renders an honest placeholder instead of a fake admin screen", () => {
    render(<ManageView item="exclusions" />);
    expect(screen.getByText(/not built yet/i)).toBeInTheDocument();
  });
});

describe("identities gate", () => {
  const gate = (over: Partial<typeof adminGate.value>) => {
    adminGate.value = {
      isAdmin: false,
      isPending: false,
      isError: false,
      retry: () => undefined,
      ...over,
    };
  };

  it("refuses a non-admin explicitly — a pasted URL must not look broken", () => {
    gate({});
    render(<ManageView item="identities" />);

    expect(screen.getByRole("alert")).toHaveTextContent(/admin surface/i);
    expect(screen.queryByText(/under construction/i)).not.toBeInTheDocument();
  });

  it("never flashes the console while the role check is in flight", () => {
    gate({ isPending: true });
    render(<ManageView item="identities" />);

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/under construction/i)).not.toBeInTheDocument();
  });

  it("opens for an admin", () => {
    gate({ isAdmin: true });
    render(<ManageView item="identities" />);

    expect(screen.getByTestId("identities-view")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says 'could not verify' with a retry when the check itself failed", async () => {
    const retry = vi.fn();
    gate({ isError: true, retry });
    render(<ManageView item="identities" />);

    expect(screen.queryByTestId("identities-view")).not.toBeInTheDocument();
    expect(screen.queryByText(/admin surface/i)).not.toBeInTheDocument();
    expect(screen.getByText(/could not verify/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

it("names the existing connector-health menu item Connectors", () => {
  expect(
    MANAGE_ITEMS.find((item) => item.id === "connector-health")?.label
  ).toBe("Connectors");
});
