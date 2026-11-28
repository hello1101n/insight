import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { EvidenceDialogContext } from "@/components/metric-evidence-context";
import { MetricsCompareTable } from "@/components/portal/metrics-compare-table";
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
        <div style={{ width: 900 }}>
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
      const value = canvas.getByRole("button", { name: new RegExp(`^${name} — `) });
      const valueEdge = value.closest("td")!.firstElementChild!.getBoundingClientRect().left;

      await expect(
        Math.abs(nameEdge - valueEdge),
        `${name} does not start where its value starts`,
      ).toBeLessThanOrEqual(1);
    }
  },
};
