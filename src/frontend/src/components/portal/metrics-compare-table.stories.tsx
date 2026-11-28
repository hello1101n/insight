import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { EvidenceDialogContext } from "@/components/metric-evidence-context";
import { MetricsCompareTable } from "@/components/portal/metrics-compare-table";
import type { MetricResult } from "@/api/metric-results-client";
import { normalizeMetricResults } from "@/lib/metrics/collection";

const PEOPLE = [
  { entityId: "019e27bc-dec0-7626-81a9-c5524662a6a9", displayName: "Alexandra Fernandez" },
  { entityId: "019e27bc-dec0-7626-81a9-c5524662a6b0", displayName: "Bo Ng" },
];

const BY_KEY = normalizeMetricResults([
  {
    metric_key: "git.commits",
    label: "Commits",
    unit: "commits",
    format: "integer",
    computation: "sum",
    direction: "higher_is_better",
    drilldown: { granularity: ["event"] },
    selection: {
      metric_key: "git.commits",
      entity: { type: "person", ids: PEOPLE.map((person) => person.entityId) },
      period: { from: "2026-10-01", to: "2026-10-31" },
      filters: [],
    },
    views: [
      {
        view: "period",
        values: [
          { entity_id: PEOPLE[0]!.entityId, value: 210 },
          { entity_id: PEOPLE[1]!.entityId, value: 822 },
        ],
      },
    ],
  },
]);

const FIGMA_PEOPLE = [
  "Alex Morgan",
  "Taylor Kim",
  "Casey Park",
  "Jamie Ellis",
  "Sam Rivera",
  "Robin Chen",
].map((displayName, index) => ({
  entityId: `019e27bc-dec0-7626-81a9-c5524662a7c${index}`,
  displayName,
}));

const FIGMA_PERIOD = { from: "2026-10-16", to: "2026-11-15" };

function figmaMetric(
  metric_key: string,
  label: string,
  shape: Pick<MetricResult, "format" | "unit" | "computation" | "direction">,
  values: ReadonlyArray<number | null>,
  drilldown = false,
): MetricResult {
  return {
    metric_key,
    label,
    ...shape,
    ...(drilldown
      ? {
          drilldown: { granularity: ["event"] },
          selection: {
            metric_key,
            entity: { type: "person", ids: FIGMA_PEOPLE.map((person) => person.entityId) },
            period: FIGMA_PERIOD,
            filters: [],
          },
        }
      : {}),
    views: [
      {
        view: "period",
        values: FIGMA_PEOPLE.map((person, index) => ({
          entity_id: person.entityId,
          value: values[index] ?? null,
        })),
      },
    ],
  } as MetricResult;
}

const FIGMA_BY_KEY = normalizeMetricResults([
  figmaMetric(
    "git.prs_merged",
    "PRs merged",
    { format: "integer", unit: null, computation: "sum", direction: "neutral" },
    [10, 8, 12, 14, 10, 16],
  ),
  figmaMetric(
    "git.pr_cycle_time_h",
    "PR cycle time",
    { format: "decimal", unit: "h", computation: "sum", direction: "lower_is_better" },
    [12, 15, 12, 9, 9, 15],
    true,
  ),
  figmaMetric(
    "git.pr_merge_rate",
    "PR merge rate",
    { format: "percent", unit: null, computation: "ratio", direction: "higher_is_better" },
    [90, 75, 85, 80, 95, 85],
  ),
  figmaMetric(
    "git.commit_size",
    "Commit size",
    { format: "integer", unit: "lines", computation: "median", direction: "lower_is_better" },
    [149, 80, 60, 40, 100, 80],
  ),
  figmaMetric(
    "collab.meeting_hours",
    "Meeting hours",
    { format: "decimal", unit: "h", computation: "sum", direction: "neutral" },
    [10, 8, null, 12, 14, 10],
  ),
  figmaMetric(
    "collab.emails_sent",
    "Emails sent",
    { format: "integer", unit: null, computation: "sum", direction: "higher_is_better" },
    [40, 24, 12, 0, 18, 24],
  ),
]);

const FIGMA_ROLES = new Map(
  ["Backend engineer", "Backend engineer", "Engineer", "Frontend engineer", "Frontend engineer", "Engineer"].map(
    (role, index) => [FIGMA_PEOPLE[index]!.entityId, role],
  ),
);

const FIGMA_TEAMS = new Map(
  FIGMA_PEOPLE.map((person, index) => [
    person.entityId,
    index < 3 ? { id: "manager-1", name: "Morgan Lee" } : { id: "manager-2", name: "Riley Shaw" },
  ]),
);

const FIGMA_ARGS = {
  keys: [...FIGMA_BY_KEY.keys()],
  byKey: FIGMA_BY_KEY,
  roles: FIGMA_ROLES,
  teams: FIGMA_TEAMS,
};

const meta: Meta<typeof MetricsCompareTable> = {
  title: "Portal/MetricsCompareTable",
  component: MetricsCompareTable,
  args: {
    people: PEOPLE,
    keys: ["git.commits"],
    byKey: BY_KEY,
    roles: new Map([[PEOPLE[0]!.entityId, "Software Engineer"]]),
    teams: new Map(),
  },
  decorators: [
    (Story) => (
      <EvidenceDialogContext.Provider
        value={{ openEvidence: () => {}, openEvidenceTargets: () => {}, openEvidencePeople: () => {} }}
      >
        <div style={{ width: 1200 }}>
          <Story />
        </div>
      </EvidenceDialogContext.Provider>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof MetricsCompareTable>;

export const TestEachNameStartsWhereItsValueStarts: Story = {
  tags: ["test"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    for (const name of ["Alexandra Fernandez", "Bo Ng"]) {
      const nameEdge = canvas.getByRole("link", { name }).getBoundingClientRect().left;
      const value = canvas.getByRole("button", { name: (accessible) => accessible.startsWith(`${name} — `) });
      const valueEdge = value.closest("td")!.firstElementChild!.getBoundingClientRect().left;

      await expect(
        Math.abs(nameEdge - valueEdge),
        `${name} does not start where its value starts`,
      ).toBeLessThanOrEqual(1);
    }
  },
};

export const TwoPeople: Story = {
  args: { ...FIGMA_ARGS, people: [FIGMA_PEOPLE[0]!, FIGMA_PEOPLE[3]!] },
};

export const SixPeople: Story = {
  args: { ...FIGMA_ARGS, people: FIGMA_PEOPLE },
};
