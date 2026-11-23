import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import type { MetricResult } from "@/api/metric-results-client";
import { MetricActivity } from "@/components/widgets/metric-views/metric-activity";
import { normalizeMetricResults } from "@/lib/metrics/collection";
import { CARD_PX_AT_390, CARD_PX_WIDE } from "@/test/storybook/layout";

const ENTITY_ID = "019e27bc-dec0-7626-81a9-c5524662a6a9";
const METRIC_KEY = "git.prs_merged";

function result(value: number, withPeer: boolean): MetricResult {
  return {
    metric_key: METRIC_KEY,
    label: "Pull requests merged",
    description: "Authored pull requests merged",
    unit: "PRs",
    format: "integer",
    computation: "sum",
    direction: "higher_is_better",
    views: [
      { view: "period", values: [{ entity_id: ENTITY_ID, value }] },
      ...(withPeer
        ? [
            {
              view: "peer",
              values: [
                {
                  entity_id: ENTITY_ID,
                  target_value: value,
                  p25: 1,
                  median: 3,
                  p75: 7,
                },
              ],
            },
          ]
        : []),
    ],
    selection: {
      metric_key: METRIC_KEY,
      entity: { type: "person", ids: [ENTITY_ID] },
      period: { from: "2026-08-24", to: "2026-08-30" },
      filters: [],
    },
  } as unknown as MetricResult;
}

function normalized(value: number, withPeer: boolean) {
  return normalizeMetricResults([result(value, withPeer)]).get(METRIC_KEY)!;
}

const meta: Meta<typeof MetricActivity> = {
  title: "Widgets/MetricViews/MetricActivity",
  component: MetricActivity,
  args: {
    metric: normalized(11, true),
    previous: normalized(14, false),
    entityId: ENTITY_ID,
    periodNoun: "week",
  },
};
export default meta;

type Story = StoryObj<typeof MetricActivity>;

export const Default: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_WIDE }}>
        <Story />
      </div>
    ),
  ],
};

export const TestWideHeaderStaysOnOneLine: Story = {
  tags: ["test"],
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_WIDE }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const name = canvas.getByText("Pull requests merged");
    const total = canvas.getByText("11 PRs");

    const nameBox = name.getBoundingClientRect();
    const totalBox = total.getBoundingClientRect();

    await expect(totalBox.top).toBeLessThan(nameBox.bottom);
    await expect(nameBox.top).toBeLessThan(totalBox.bottom);
  },
};

export const TestNarrowHeaderStacksInsteadOfOverlapping: Story = {
  tags: ["test"],
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_AT_390 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const name = canvas.getByText("Pull requests merged");
    const column = name.closest("div")!;
    const columnBox = column.getBoundingClientRect();
    const rowBox = column.parentElement!.getBoundingClientRect();
    const totalBox = canvas.getByText("11 PRs").getBoundingClientRect();

    await expect(
      totalBox.top,
      `the figures share the name's line (name ends ${columnBox.bottom}, figures start ${totalBox.top})`
    ).toBeGreaterThanOrEqual(columnBox.bottom);

    await expect(
      columnBox.width,
      `the name column is ${columnBox.width}px of a ${rowBox.width}px row`
    ).toBeGreaterThan(rowBox.width / 2);
  },
};
