import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import type { MetricResult } from "@/api/metric-results-client";
import { SectionMetricIndex } from "@/components/widgets/metric-views/section-metric-index";
import { normalizeMetricResults } from "@/lib/metrics/collection";
import {
  CARD_PX_AT_390,
  CARD_PX_WIDE,
  expectHorizontallyContained,
} from "@/test/storybook/layout";

const ENTITY_ID = "019e27bc-dec0-7626-81a9-c5524662a6a9";

const LONG_NAME = "Merges without approval rate";

function metric(
  key: string,
  label: string,
  value: number,
  unit: string | null,
  median: number
): MetricResult {
  return {
    metric_key: key,
    label,
    unit,
    format: "integer",
    computation: "sum",
    direction: "higher_is_better",
    views: [
      { view: "period", values: [{ entity_id: ENTITY_ID, value }] },
      {
        view: "peer",
        values: [
          {
            entity_id: ENTITY_ID,
            target_value: value,
            p25: 1,
            median,
            p75: 100000,
          },
        ],
      },
    ],
  } as unknown as MetricResult;
}

const RESULTS = [
  metric("git.long", LONG_NAME, 325, null, 731),
  metric("git.short", "Merge rate", 12408, "lines", 9),
];

const meta: Meta<typeof SectionMetricIndex> = {
  title: "Widgets/MetricViews/SectionMetricIndex",
  component: SectionMetricIndex,
  args: {
    collection: { metrics: RESULTS.map((r) => ({ key: r.metric_key, views: [] })) },
    byKey: normalizeMetricResults(RESULTS),
    entityId: ENTITY_ID,
    shown: new Set<string>(),
  },
};
export default meta;

type Story = StoryObj<typeof SectionMetricIndex>;

export const Default: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_WIDE }}>
        <Story />
      </div>
    ),
  ],
};

export const TestWideRowStaysOnOneLine: Story = {
  tags: ["test"],
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_WIDE }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas, canvasElement }) => {
    const name = canvas.getByText(LONG_NAME).getBoundingClientRect();
    const value = canvas.getByText("325").getBoundingClientRect();

    await expect(value.top, "the readings dropped to their own line").toBeLessThan(
      name.bottom
    );
    await expect(name.top).toBeLessThan(value.bottom);

    const readings = canvasElement.querySelectorAll("dd");
    const columns = Array.from(readings).map((dd) =>
      Array.from(dd.children)
        .slice(0, 2)
        .map((span) => Math.round(span.getBoundingClientRect().width))
    );
    await expect(
      columns,
      `the value and median columns are not the fixed 128/112 (${JSON.stringify(columns)})`
    ).toEqual([
      [128, 112],
      [128, 112],
    ]);
  },
};

export const TestNarrowRowKeepsTheMetricName: Story = {
  tags: ["test"],
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_AT_390 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas, canvasElement }) => {
    const column = canvas.getByText(LONG_NAME).closest("dt")!;
    const value = canvas.getByText("325");
    const columnBox = column.getBoundingClientRect();

    const list = canvasElement.querySelector("dl");
    await expect(list, "the index renders its list").not.toBeNull();
    const row = column.parentElement!.getBoundingClientRect();

    await expect(
      columnBox.width,
      `the name column is ${columnBox.width}px of a ${row.width}px row`
    ).toBeGreaterThan(row.width / 2);
    await expect(
      value.getBoundingClientRect().top,
      "the readings share the name's line"
    ).toBeGreaterThanOrEqual(columnBox.bottom);

    expectHorizontallyContained(
      list!,
      Array.from(list!.querySelectorAll("dd")),
      () => "a row's readings"
    );
  },
};
