// @vitest-environment jsdom
vi.mock("@/lib/portal/use-cohort-label", () => ({
  useCohortLabel: () => "team",
}));
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";

import type { MetricResult } from "@/api/metric-results-client";
import type { GroupId } from "@/lib/insight/groups";
import { normalizeMetricResults } from "@/lib/metrics/collection";

const mocks = vi.hoisted(() => ({
  collection: {
    byKey: new Map(),
    previousByKey: new Map(),
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  },
  set: new Map<string, { byKey: Map<string, never>; isPending: boolean; isError: boolean; refetch: () => void }>(),
  cohort: [] as string[],
  period: "week" as const,
  range: { from: "2026-07-20", to: "2026-07-26" },
  compareTo: { from: "2026-07-13", to: "2026-07-19" },
  setCalls: [] as Array<{
    collections: unknown;
    entity: { type: string; ids?: string[] };
    range: { from: string; to: string };
    compareTo?: { from: string; to: string };
  }>,
  collectionEntities: [] as Array<{ type: string; ids?: string[] }>,
}));

vi.mock("@/queries/metric-definitions", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useMetricDefinitionsResponse: () => ({
    data: { metrics: [] },
    isPending: false,
    isError: false,
  }),
}));
vi.mock("@/queries/metric-results", () => ({
  useMetricCollection: (
    _collection: unknown,
    entity: { type: string; ids?: string[] },
  ) => {
    mocks.collectionEntities.push(entity);
    return mocks.collection;
  },
  useMetricCollectionSet: (
    collections: unknown,
    entity: { type: string; ids?: string[] },
    range: { from: string; to: string },
    compareTo?: { from: string; to: string }
  ) => {
    mocks.setCalls.push({ collections, entity, range, compareTo });
    return mocks.set;
  },
  collectionSetPending: (set: Map<string, { isPending: boolean }>) =>
    [...set.values()].some((r) => r.isPending),
}));
vi.mock("@/lib/portal/use-person-cohort", () => ({
  usePersonCohort: () => mocks.cohort,
}));
vi.mock("@/lib/portal/use-nav-location", () => ({
  useNavLocation: () => ({ zone: "person", item: null, person: "", dir: "", lens: "" }),
}));
vi.mock("@/hooks/use-portal-period", () => ({
  usePortalPeriod: () => ({
    period: mocks.period,
    dateRange: mocks.range,
    compareTo: mocks.compareTo,
    comparisonNoun: mocks.period,
  }),
}));
vi.mock("@/components/widgets/dashboard/kpi-tile", () => ({
  KpiTile: ({
    tile,
    onOpenGroup,
  }: {
    tile: { key: string; groupId: string | null };
    onOpenGroup?: (id: string) => void;
  }) => (
    <button
      data-testid="kpi-tile"
      onClick={() => tile.groupId && onOpenGroup?.(tile.groupId)}
    >
      {tile.key}
    </button>
  ),
  KpiTilePlaceholder: () => <div data-testid="kpi-placeholder" />,
}));
vi.mock("@/components/widgets/dashboard/ic-needs-attention", () => ({
  IcNeedsAttention: () => <div data-testid="needs-attention" />,
}));
vi.mock("@/components/widgets/dashboard/group-drilldown-sheet", () => ({
  GroupDrilldownSheet: ({ open, def }: { open: boolean; def: { id: string } }) =>
    open ? <div data-testid={`drilldown-${def.id}`} /> : null,
}));

import { MetricGroupsView } from "./metric-groups-view";

const GROUPS: readonly GroupId[] = ["git_output", "collaboration"];

function metric(key: string): MetricResult {
  return {
    metric_key: key,
    label: key,
    unit: null,
    format: "integer",
    direction: "higher_is_better",
    computation: "sum",
    views: [{ view: "period", values: [{ entity_id: "p@x", value: 3 }] }],
  } as MetricResult;
}

const GROUP_METRIC: Record<string, string> = {
  git_output: "git.default_branch_commits",
  collaboration: "collab.messages_sent",
};

function seedSet(
  over: Partial<{ isPending: boolean; isError: boolean }> = {},
  { withData = true } = {},
) {
  mocks.set = new Map(
    GROUPS.map((id) => [
      id as string,
      {
        byKey: withData
          ? normalizeMetricResults([metric(GROUP_METRIC[id]!)])
          : new Map<string, never>(),
        isPending: false,
        isError: false,
        refetch: vi.fn() as () => void,
        ...over,
      },
    ]),
  ) as typeof mocks.set;
}

beforeEach(() => {
  mocks.collection.isPending = false;
  mocks.collection.isError = false;
  mocks.cohort = [];
  mocks.collectionEntities = [];
  mocks.setCalls.length = 0;
  seedSet();
});

describe("MetricGroupsView", () => {
  it("renders an honest note when no group is in the semantic layer", () => {
    render(<MetricGroupsView personId="p@x" groupIds={[]} />);
    expect(screen.getByText(/Not available yet for this direction/)).toBeInTheDocument();
  });

  it("spins while any group collection is pending", () => {
    seedSet({ isPending: true });
    render(<MetricGroupsView personId="p@x" groupIds={GROUPS} />);
    expect(screen.queryByTestId("group-card-git_output")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("surfaces a group failure as a retryable error, not empty cards", async () => {
    seedSet({ isError: true });
    render(<MetricGroupsView personId="p@x" groupIds={GROUPS} />);
    expect(screen.queryByTestId("group-card-git_output")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(mocks.set.get("git_output")!.refetch).toHaveBeenCalled();
  });

  it("renders NO section cards — the nav carries the sections", () => {
    render(<MetricGroupsView personId="p@x" groupIds={GROUPS} />);
    expect(screen.queryByTestId("group-card-git_output")).not.toBeInTheDocument();
    expect(screen.queryByTestId("group-card-collaboration")).not.toBeInTheDocument();
    expect(screen.queryByTestId("needs-attention")).not.toBeInTheDocument();
  });

  it("shows the KPI row + needs-attention only on the glance", () => {
    render(<MetricGroupsView personId="p@x" groupIds={GROUPS} content="glance" />);
    expect(screen.getByText("At a glance")).toBeInTheDocument();
    expect(screen.getByTestId("needs-attention")).toBeInTheDocument();
  });

  it("shows the attention list alone, without asking for the KPI row", () => {
    render(<MetricGroupsView personId="p@x" groupIds={GROUPS} content="attention" />);

    expect(screen.queryByText("At a glance")).not.toBeInTheDocument();
    expect(
      mocks.collectionEntities.every((entity) => (entity.ids?.length ?? 0) === 0),
    ).toBe(true);
  });

  it("says nothing stands out when no metric is worth a look", () => {
    render(<MetricGroupsView personId="p@x" groupIds={GROUPS} content="attention" />);

    expect(screen.getByText("Nothing stands out this period.")).toBeInTheDocument();
  });

  it("asks for the sections over one window pair, not a shifted second request", () => {
    render(<MetricGroupsView personId="p@x" groupIds={GROUPS} content="glance" />);
    for (const call of mocks.setCalls) {
      expect(call.range, `range for ${JSON.stringify(call.entity)}`).toEqual(
        mocks.range,
      );
    }
    const sections = mocks.setCalls.filter((c) => (c.entity.ids?.length ?? 0) > 0);
    const signatures = new Set(sections.map((c) => JSON.stringify(c)));
    expect(sections.length).toBeGreaterThan(1);
    expect(signatures.size).toBe(1);
    expect(sections[0]!.compareTo).toEqual(mocks.compareTo);
  });

  it("asks for the slice cohort under one signature too", () => {
    mocks.cohort = ["a@x", "b@x"];
    render(<MetricGroupsView personId="p@x" groupIds={GROUPS} content="glance" />);
    const cohort = mocks.setCalls.filter(
      (c) => c.entity.ids?.join() === mocks.cohort.join(),
    );
    expect(cohort.length).toBeGreaterThan(1);
    expect(new Set(cohort.map((c) => JSON.stringify(c))).size).toBe(1);
  });

  it("routes a KPI tile through onSelectGroup instead of the modal when provided", async () => {
    mocks.collection.byKey = normalizeMetricResults([
      {
        ...metric("git.default_branch_commits"),
        views: [
          { view: "period", values: [{ entity_id: "p@x", value: 3 }] },
          {
            view: "peer",
            values: [
              {
                entity_id: "p@x",
                target_value: 3,
                p25: 1,
                median: 5,
                p75: 9,
                min: 0,
                max: 12,
                n: 8,
              },
            ],
          },
        ],
      } as MetricResult,
    ]);
    const onSelect = vi.fn();
    render(
      <MetricGroupsView
        personId="p@x"
        groupIds={GROUPS}
        content="glance"
        onSelectGroup={onSelect}
      />,
    );
    await userEvent.click(screen.getAllByTestId("kpi-tile")[0]!);
    expect(onSelect).toHaveBeenCalled();
    expect(screen.queryByTestId("drilldown-git_output")).not.toBeInTheDocument();
  });
});
