import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import type { MetricResult } from "@/api/metric-results-client";
import { MembersGrid } from "@/components/widgets/dashboard/members-grid";
import { normalizeMetricResults } from "@/lib/metrics/collection";
import {
  CARD_PX_AT_390,
  CARD_PX_WIDE,
  expectHorizontallyContained,
} from "@/test/storybook/layout";

const MEMBERS = [
  { entityId: "019e27bc-dec0-7626-81a9-c5524662a6a9", displayName: "Alexandra Fernandez" },
  { entityId: "019e27bc-dec0-7626-81a9-c5524662a6b0", displayName: "Bo Ng" },
];

function metric(
  key: string,
  shortLabel: string,
  members: typeof MEMBERS = MEMBERS
): MetricResult {
  return {
    metric_key: key,
    label: `${shortLabel} over the period`,
    short_label: shortLabel,
    unit: null,
    format: "integer",
    computation: "sum",
    direction: "higher_is_better",
    views: [
      {
        view: "period",
        values: members.map((m, index) => ({
          entity_id: m.entityId,
          value: 100 + index,
        })),
      },
      {
        view: "peer",
        values: members.map((m, index) => ({
          entity_id: m.entityId,
          target_value: 100 + index,
          p25: 50,
          median: 100,
          p75: 150,
          min: 0,
          max: 200,
          n: 12,
        })),
      },
    ],
  } as unknown as MetricResult;
}

const RESULTS = [
  metric("git.commits", "Commits"),
  metric("git.prs_merged", "PRs merged"),
  metric("git.code_lines", "Code lines"),
  metric("collab.messages", "Msgs"),
  metric("collab.meeting_hours", "Mtg hrs"),
  metric("ai.active_days", "AI days"),
];

const meta: Meta<typeof MembersGrid> = {
  title: "Widgets/Dashboard/MembersGrid",
  component: MembersGrid,
  args: {
    members: MEMBERS,
    metricKeys: RESULTS.map((r) => r.metric_key),
    byKey: normalizeMetricResults(RESULTS),
    caption: "Members grid",
  },
};
export default meta;

type Story = StoryObj<typeof MembersGrid>;

export const Default: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_WIDE }}>
        <Story />
      </div>
    ),
  ],
};

function memberColumnWidth(table: Element): number {
  const header = table.querySelector("thead th");
  return Math.round(header!.getBoundingClientRect().width);
}

export const TestNarrowRosterShowsAWholeMetricColumn: Story = {
  tags: ["test"],
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_AT_390 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const table = canvas.getByRole("table", { name: "Members grid" });
    const scroller = table.parentElement!;

    const firstMetric = canvas.getByRole("button", {
      name: "Commits over the period — sort by this column",
    });
    expectHorizontallyContained(
      scroller,
      [firstMetric.closest("th")!],
      () => "the first metric column"
    );

    const name = canvas.getByRole("link", { name: "Alexandra Fernandez" });
    await expect(
      Math.round(name.getBoundingClientRect().width),
      "the member column collapsed the name away"
    ).toBeGreaterThan(80);
  },
};

export const TestWideRosterKeepsTheComfortableNameColumn: Story = {
  tags: ["test"],
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_WIDE }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const table = canvas.getByRole("table", { name: "Members grid" });
    const width = memberColumnWidth(table);
    await expect(
      width,
      `the member column is ${width}px on a ${CARD_PX_WIDE}px card`
    ).toBe(256);
  },
};

const LONG_ROSTER = Array.from({ length: 40 }, (_, index) => ({
  entityId: `019e27bc-dec0-7626-81a9-c5524662${String(index).padStart(4, "0")}`,
  displayName: `Member ${index + 1}`,
}));

const LONG_RESULTS = RESULTS.map((result) =>
  metric(result.metric_key, result.short_label!, LONG_ROSTER)
);

export const TestHeadingsHoldWhileTheRosterScrolls: Story = {
  tags: ["test"],
  args: {
    members: LONG_ROSTER,
    metricKeys: LONG_RESULTS.map((r) => r.metric_key),
    byKey: normalizeMetricResults(LONG_RESULTS),
  },
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_WIDE }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const table = canvas.getByRole("table", { name: "Members grid" });
    const scroller = table.parentElement!;

    scroller.scrollTop = 400;
    scroller.scrollLeft = 300;
    await expect(
      scroller.scrollTop,
      "the roster does not scroll vertically, so nothing can hold on scroll"
    ).toBeGreaterThan(0);

    const box = scroller.getBoundingClientRect();
    const metricHeader = canvas
      .getByRole("button", {
        name: "Commits over the period — sort by this column",
      })
      .closest("th")!;
    const memberHeader = table.querySelector("thead th")!;

    const drop = metricHeader.getBoundingClientRect().top - box.top;
    await expect(
      Math.abs(drop),
      `the metric heading sits ${Math.round(drop)}px from the top of the roster`
    ).toBeLessThanOrEqual(1);

    const corner = memberHeader.getBoundingClientRect();
    await expect(
      Math.abs(corner.top - box.top),
      "the Person heading left the top of the roster"
    ).toBeLessThanOrEqual(1);
    await expect(
      Math.abs(corner.left - box.left),
      "the Person heading left the start of the roster"
    ).toBeLessThanOrEqual(1);
  },
};
