// @vitest-environment jsdom
vi.mock("@tanstack/react-router", async () => {
  const { portalRouterMock } = await import("@/test/portal-router");
  return portalRouterMock();
});

import { portalRouter } from "@/test/portal-router";

import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import { setPortalShowPlanned } from "@/lib/portal/portal-store";
import {
  identityPerson,
  peopleFromIdentityTree,
  pid,
} from "@/test/identity";
import type { IdentityPerson, TeamMember } from "@/types/insight";

const mocks = vi.hoisted(() => ({
  personId: null as string | null,
  tree: undefined as IdentityPerson | undefined,
  roster: [] as import("@/api/identity-client").PeopleListItem[],
  members: [] as TeamMember[],
  grid: {
    byKey: new Map<string, NormalizedMetricResult>(),
    previousByKey: new Map<string, NormalizedMetricResult>(),
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  },
  tools: {
    byKey: new Map<string, NormalizedMetricResult>(),
    previousByKey: null,
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({
  useViewer: () => ({ email: "boss@x", personId: mocks.personId }),
}));
vi.mock("@/lib/portal/use-cohort-label", () => ({
  useCohortLabel: () => "team",
}));
vi.mock("@/queries/ic-dashboard", () => ({
  useIcPerson: () => ({ data: mocks.tree, isPending: false, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/queries/identity-me", () => ({
  useVisibilityPolicy: () => ({
    policy: "org_chart",
    isFlat: false,
    isPending: false,
  }),
}));
vi.mock("@/queries/visible-roster", () => ({
  useVisibleRoster: () => ({
    roster: mocks.roster,
    isPending: false,
    isError: false,
    retry: () => {},
  }),
}));
vi.mock("@/queries/team-view", () => ({
  useTeamMembers: () => ({ data: mocks.members, isPending: false, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock("@/queries/member-grid", () => ({ useMemberGridData: () => mocks.grid }));
vi.mock("@/queries/metric-results", () => ({ useMetricCollection: () => mocks.tools }));
vi.mock("@/hooks/use-portal-period", () => ({
  usePortalPeriod: () => ({ period: "week", dateRange: { from: "2026-07-20", to: "2026-07-26" } }),
}));


import { AiCostView } from "./ai-cost-view";

const person = (
  label: string,
  over: Partial<IdentityPerson> = {},
  subs: IdentityPerson[] = [],
): IdentityPerson => identityPerson(label, over, subs);

const member = (id: string): TeamMember =>
  ({ person_id: id, name: `Name ${id.split("@")[0]}` }) as unknown as TeamMember;

function metric(
  key: string,
  period: Array<[string, number | null]>,
  over: Partial<NormalizedMetricResult> = {},
): NormalizedMetricResult {
  return {
    metric_key: key,
    label: key,
    unit: null,
    computation: "sum",
    format: "integer",
    direction: "higher_is_better",
    period: { view: "period", values: period.map(([entity_id, value]) => ({ entity_id, value })) },
    peer: { view: "peer", values: period.map(([entity_id, value]) => ({ entity_id, target_value: value })) },
    ...over,
  } as unknown as NormalizedMetricResult;
}

function toolBreakdown(
  key: string,
  rows: Array<[string, string, number]>,
): NormalizedMetricResult {
  return {
    ...metric(key, []),
    breakdown: {
      view: "breakdown",
      values: rows.map(([entity_id, tool, value]) => ({
        entity_id,
        dimensions: [{ key: "tool", value: tool }],
        value,
      })),
    },
  } as unknown as NormalizedMetricResult;
}

const LABELS = ["a", "b", "c", "d"];
const IDS = LABELS.map(pid);

beforeEach(() => {
  mocks.personId = pid("boss");
  mocks.tree = person("boss", {}, LABELS.map((l) => person(l)));
  mocks.roster = peopleFromIdentityTree(mocks.tree);
  mocks.members = IDS.map(member);
  mocks.grid.isPending = false;
  mocks.grid.isError = false;
  mocks.tools.isError = false;
  mocks.grid.byKey = new Map([
    ["ai.cost", metric("ai.cost", [[pid("a"), 100], [pid("b"), 50], [pid("c"), 0], [pid("d"), 0]], { label: "Potential cost as the API names it", format: "currency", unit: "USD" } as never)],
    ["ai.daily_approximate_extra_usage_cost", metric("ai.daily_approximate_extra_usage_cost", [[pid("a"), 8], [pid("b"), 4], [pid("c"), 0], [pid("d"), 0]], { format: "currency", unit: "USD" } as never)],
    ["ai.active_days", metric("ai.active_days", [[pid("a"), 5], [pid("b"), 3], [pid("c"), 1], [pid("d"), 0]])],
    ["ai.accepted_lines", metric("ai.accepted_lines", [[pid("a"), 700], [pid("b"), 200], [pid("c"), 100], [pid("d"), 0]])],
  ]);
  mocks.grid.previousByKey = new Map();
  mocks.tools.byKey = new Map([
    ["ai.cost", toolBreakdown("ai.cost", [[pid("a"), "claude_code", 100], [pid("b"), "claude_code", 50]])],
    ["ai.daily_approximate_extra_usage_cost", toolBreakdown("ai.daily_approximate_extra_usage_cost", [
      [pid("a"), "claude", 8],
      [pid("b"), "claude", 4],
    ])],
    ["ai.accepted_lines", toolBreakdown("ai.accepted_lines", [
      [pid("a"), "claude_code", 600],
      [pid("b"), "chatgpt", 300],
      [pid("c"), "chatgpt", 100],
    ])],
  ]);
  act(() => {
    portalRouter.set({ slice: undefined });
    portalRouter.set({ scope: undefined, direct: false });
    setPortalShowPlanned(true);
  });
});

describe("AiCostView", () => {
  it("renders headline KPIs: Claude-only cost, active users, org lines", () => {
    render(<AiCostView item={null} />);
    const costTile = screen.getByText("Claude Code only").parentElement;
    expect(costTile).toHaveTextContent("Potential cost as the API names it");
    expect(screen.getByText("Claude Code only")).toBeInTheDocument();
    expect(screen.getByText("Active AI users")).toBeInTheDocument();
    expect(screen.getByText("60% of 5")).toBeInTheDocument();
    expect(screen.getByText(/1[,  ]?000/)).toBeInTheDocument();
  });

  it("holds the actual cost beside the potential one rather than summing them", () => {
    render(<AiCostView item={null} />);
    expect(screen.getAllByText("$150").length).toBeGreaterThan(0);
    expect(screen.getByText("actual cost $12")).toBeInTheDocument();
    expect(screen.queryByText("$162")).not.toBeInTheDocument();
    expect(screen.getAllByText("$50").length).toBeGreaterThan(0);
    expect(screen.getByText("avg actual $4 / active user")).toBeInTheDocument();
    expect(screen.queryByText("$54")).not.toBeInTheDocument();
  });

  it("omits the actual figure entirely when no seat data reaches us", () => {
    const drop = <T,>(m: Map<string, T>) =>
      new Map([...m].filter(([key]) => key !== "ai.daily_approximate_extra_usage_cost"));
    mocks.grid.byKey = drop(mocks.grid.byKey);
    mocks.tools.byKey = drop(mocks.tools.byKey);
    render(<AiCostView item={null} />);
    const costTile = screen.getByText("Claude Code only").parentElement;
    expect(costTile).toHaveTextContent("Potential cost as the API names it");
    expect(screen.queryByText(/actual cost/)).not.toBeInTheDocument();
    expect(screen.queryByText(/actual .* \/ active user/)).not.toBeInTheDocument();
  });

  it("omits the actual figure when the metric is served but nobody has a reading", () => {
    mocks.grid.byKey = new Map([
      ...mocks.grid.byKey,
      [
        "ai.daily_approximate_extra_usage_cost",
        metric("ai.daily_approximate_extra_usage_cost", [], {
          format: "currency",
          unit: "USD",
        } as never),
      ],
    ]);
    mocks.tools.byKey = new Map([
      ...mocks.tools.byKey,
      [
        "ai.daily_approximate_extra_usage_cost",
        toolBreakdown("ai.daily_approximate_extra_usage_cost", []),
      ],
    ]);
    render(<AiCostView item={null} />);
    expect(screen.queryByText(/actual cost/)).not.toBeInTheDocument();
  });

  it("omits the potential figure too when nobody has a reading for it", () => {
    mocks.grid.byKey = new Map([
      ...mocks.grid.byKey,
      ["ai.cost", metric("ai.cost", [], { label: "Potential cost as the API names it", format: "currency", unit: "USD" } as never)],
    ]);
    mocks.tools.byKey = new Map([
      ...mocks.tools.byKey,
      ["ai.cost", toolBreakdown("ai.cost", [])],
    ]);
    render(<AiCostView item={null} />);
    expect(screen.queryByText("$150")).not.toBeInTheDocument();
    expect(screen.queryByText("$50")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows per-tool cards where untracked cost reads 'not tracked', never $0", () => {
    render(<AiCostView item={null} />);
    expect(screen.getAllByText("Claude Code").length).toBeGreaterThan(0);
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(screen.getByText("potential cost not tracked")).toBeInTheDocument();
    expect(screen.getByText("2 users · 400 lines")).toBeInTheDocument();
    expect(
      screen.getByText("actual cost $12 · 1 users · 600 lines"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Only Claude Code is usage-metered/)).toBeInTheDocument();
    expect(
      screen.getByText(/Actual cost is the vendor’s monthly bill spread/),
    ).toBeInTheDocument();
  });

  it("computes the adoption funnel with data-relative stage cuts", () => {
    render(<AiCostView item="adoption-funnel" />);
    expect(screen.getByText("Adoption funnel")).toBeInTheDocument();
    expect(screen.getByText("In org")).toBeInTheDocument();
    expect(screen.getByText("Used AI (≥1 day)")).toBeInTheDocument();
    expect(screen.getByText(/Active \(≥3 days · median\)/)).toBeInTheDocument();
    expect(screen.getByText(/Heavy \(≥4 days · top quartile\)/)).toBeInTheDocument();
  });

  it("surfaces a failed per-tool breakdown instead of calling it empty", () => {
    mocks.tools.isError = true;
    render(<AiCostView item={null} />);
    expect(screen.getByText("Unable to load the per-tool breakdown")).toBeInTheDocument();
    expect(
      screen.queryByText(/No per-tool breakdown for this period/),
    ).not.toBeInTheDocument();
  });

  it("renders an honest ComingSoon for unwired pane items", () => {
    render(<AiCostView item="autofix" />);
    expect(screen.getByText(/no autofix data is collected/i)).toBeInTheDocument();
    expect(screen.queryByText("AI potential cost")).not.toBeInTheDocument();
  });

  it("groups cost and adoption by unit when a slice is active", () => {
    mocks.tree = person("boss", {}, [
      person("a", { division: "R&D" } as never),
      person("b", { division: "R&D" } as never),
      person("c", { division: "Sales" } as never),
      person("d", { division: "Sales" } as never),
    ]);
    mocks.roster = peopleFromIdentityTree(mocks.tree);
    act(() => portalRouter.set({ slice: "division" }));
    render(<AiCostView item="by-unit-role" />);
    expect(screen.getByText("R&D")).toBeInTheDocument();
    expect(screen.getByText("Sales")).toBeInTheDocument();
    expect(screen.getByText("Potential cost")).toBeInTheDocument();
    expect(screen.getByText("Actual cost")).toBeInTheDocument();
    expect(screen.getByText("$12")).toBeInTheDocument();
    const salesCells = screen.getByText("Sales").closest("tr")?.querySelectorAll("td");
    expect(salesCells?.[4]?.textContent).toBe("$0");
  });

  it("says a unit has no billed figure rather than calling it $0", () => {
    mocks.grid.byKey = new Map([
      ...mocks.grid.byKey,
      [
        "ai.daily_approximate_extra_usage_cost",
        metric(
          "ai.daily_approximate_extra_usage_cost",
          [[pid("a"), 8], [pid("b"), 4]],
          { format: "currency", unit: "USD" } as never,
        ),
      ],
    ]);
    mocks.tree = person("boss", {}, [
      person("a", { division: "R&D" } as never),
      person("b", { division: "R&D" } as never),
      person("c", { division: "Sales" } as never),
      person("d", { division: "Sales" } as never),
    ]);
    mocks.roster = peopleFromIdentityTree(mocks.tree);
    act(() => portalRouter.set({ slice: "division" }));
    render(<AiCostView item="by-unit-role" />);
    const cells = screen.getByText("Sales").closest("tr")?.querySelectorAll("td");
    expect(cells?.[4]?.textContent).toBe("—");
  });

  it("counts the lead with their reports, as the People roster does", () => {
    render(<AiCostView item={null} />);
    expect(screen.getByText(/boss's org · 5 people/)).toBeInTheDocument();
    expect(screen.getByText("boss")).toBeInTheDocument();
  });

  it("gates on an empty scope instead of rendering zero KPIs", () => {
    mocks.members = [];
    mocks.tree = undefined;
    mocks.roster = [];
    render(<AiCostView item={null} />);
    expect(screen.getByText(/No people in the current scope/)).toBeInTheDocument();
    expect(screen.queryByText("AI potential cost")).not.toBeInTheDocument();
  });
});
