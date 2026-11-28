// @vitest-environment jsdom
vi.mock("@tanstack/react-router", async () => {
  const { portalRouterMock } = await import("@/test/portal-router");
  return portalRouterMock();
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider } from "@gears-frontx/ui-kit";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MetricDefinitionListResponse } from "@/api/metric-definitions-client";
import { setPortalShowPlanned } from "@/lib/portal/portal-store";
import { identityPerson, peopleFromIdentityTree, pid } from "@/test/identity";

const roster = peopleFromIdentityTree(
  identityPerson("boss", {
    person_id: pid("boss"),
    division: "Alpha",
    subordinates: [
      identityPerson("one", { person_id: pid("one"), division: "Alpha" }),
      identityPerson("two", { person_id: pid("two"), division: "Beta" }),
    ],
  }),
);

const mocks = vi.hoisted(() => ({
  definitions: { metrics: [] } as MetricDefinitionListResponse,
  isFlat: false,
}));

vi.mock("@/queries/identity-me", () => ({
  useVisibilityPolicy: () => ({
    policy: mocks.isFlat ? "flat" : "org_chart",
    isFlat: mocks.isFlat,
    isPending: false,
  }),
  useIsAdmin: () => ({ isAdmin: false, isPending: false }),
}));
vi.mock("@/queries/visible-roster", () => ({
  useVisibleRoster: () => ({
    roster,
    isPending: false,
    isError: false,
    retry: () => {},
  }),
}));

vi.mock("@/api/metric-definitions-client", () => ({
  listMetricDefinitions: () => Promise.resolve(mocks.definitions),
}));
vi.mock("@/queries/ic-dashboard", () => ({
  useIcPerson: () => ({
    data: identityPerson("boss", {
      person_id: pid("boss"),
      division: "Alpha",
      subordinates: [
        identityPerson("one", { person_id: pid("one"), division: "Alpha" }),
        identityPerson("two", { person_id: pid("two"), division: "Beta" }),
      ],
    }),
  }),
}));
vi.mock("@/auth", () => ({ useViewer: () => ({ personId: pid("boss") }) }));
vi.mock("@/hooks/use-portal-period", () => ({
  usePortalPeriod: () => ({
    period: "month",
    customRange: null,
    setPeriod: vi.fn(),
    setCustomRange: vi.fn(),
  }),
}));
vi.mock("@/components/widgets/period-selector-bar", () => ({
  PeriodSelectorBar: () => <div data-testid="period-bar" />,
}));
vi.mock("@/components/portal/slice-select", () => ({
  SliceSelect: ({ dims }: { dims: { key: string; label: string }[] }) => (
    <div data-testid="dims">{dims.map((d) => d.key).join(",")}</div>
  ),
}));

import { portalRouter } from "@/test/portal-router";

import { PortalTopBar } from "./portal-topbar";

function bar() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SidebarProvider>
        <PortalTopBar />
      </SidebarProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  mocks.definitions = { metrics: [] };
  mocks.isFlat = false;
  act(() => setPortalShowPlanned(true));
  portalRouter.reset();
});

describe("PortalTopBar", () => {
  it("offers what the catalog allows once the response carries it", async () => {
    mocks.definitions = {
      metrics: [],
      comparison_attributes: [{ id: "job_title", label: "Title" }],
    } as MetricDefinitionListResponse;
    bar();
    await waitFor(() =>
      expect(screen.getByTestId("dims")).toHaveTextContent("job_title"),
    );
  });

  it("prefers the catalog over what the roster happens to support", async () => {
    mocks.definitions = {
      metrics: [],
      comparison_attributes: [{ id: "job_title", label: "Title" }],
    } as MetricDefinitionListResponse;
    bar();
    await waitFor(() =>
      expect(screen.getByTestId("dims")).not.toHaveTextContent("division"),
    );
  });

  it("falls back to the roster while no catalog exists", async () => {
    bar();
    await waitFor(() =>
      expect(screen.getByTestId("dims")).toHaveTextContent("division"),
    );
  });
});

const filters = () => screen.queryByRole("group", { name: "View filters" });

describe("PortalTopBar · zones that filter nothing", () => {
  it("drops the whole filter group on Manage", async () => {
    portalRouter.go("/manage/assistant");
    bar();

    await waitFor(() => expect(screen.queryByTestId("dims")).toBeNull());
    expect(filters()).toBeNull();
  });

  it("keeps it on a zone whose numbers the filters move", async () => {
    portalRouter.go("/home");
    bar();

    await waitFor(() => expect(filters()).toBeInTheDocument());
  });

  it("drops the cohort control where there is one cohort", async () => {
    mocks.isFlat = true;

    bar();

    expect(screen.queryByText("Cohort")).toBeNull();
  });
});

describe("PortalTopBar · planned sections", () => {
  it("keeps the cohort control off the bar until the reader turns planned sections on", async () => {
    act(() => setPortalShowPlanned(false));
    bar();

    await waitFor(() => expect(filters()).toBeInTheDocument());
    expect(screen.queryByText("Cohort")).toBeNull();
    expect(screen.queryByTestId("dims")).toBeNull();

    act(() => setPortalShowPlanned(true));
    expect(screen.getByText("Cohort")).toBeInTheDocument();
  });
});

describe("PortalTopBar · team over time", () => {
  it("shows the change date and the window instead of the period presets", async () => {
    act(() => portalRouter.set({ team: pid("boss"), change: "2025-10-15", weeks: 2 }));
    bar();

    expect(await screen.findByText("15 Oct 2025 · 14 days each")).toBeInTheDocument();
    expect(screen.queryByTestId("period-bar")).not.toBeInTheDocument();
  });

  it("keeps the period presets without a team in the link", async () => {
    bar();

    expect(await screen.findByTestId("period-bar")).toBeInTheDocument();
    expect(screen.queryByText(/days each/)).not.toBeInTheDocument();
  });
});
