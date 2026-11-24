import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";

import type { MetricResult } from "@/api/metric-results-client";
import { EvidenceDialogContext } from "@/components/metric-evidence-context";
import { MetricHistogram } from "@/components/widgets/metric-views/metric-histogram";
import { normalizeMetricResults } from "@/lib/metrics/collection";

const ENTITY_ID = "me@example.com";

const BINS = [
  { lo: 0, hi: 10, count: 3 },
  { lo: 10, hi: 20, count: 5 },
  { lo: 20, hi: 30, count: 2 },
  { lo: 30, hi: 40, count: 1 },
];

function drilldownMetric() {
  const result: MetricResult = {
    metric_key: "git.pr_cycle_time_h",
    label: "PR cycle time",
    unit: "hours",
    format: "decimal",
    direction: "lower_is_better",
    computation: "median",
    drilldown: { granularity: ["event"] },
    selection: {
      metric_key: "git.pr_cycle_time_h",
      entity: { type: "person", ids: [ENTITY_ID] },
      period: { from: "2026-07-01", to: "2026-07-31" },
      filters: [],
    },
    views: [
      { view: "period", values: [{ entity_id: ENTITY_ID, value: 749 }] },
      {
        view: "peer",
        values: [
          {
            entity_id: ENTITY_ID,
            target_value: 749,
            p25: null,
            median: 157,
            p75: null,
            min: null,
            max: null,
            n: 10,
          },
        ],
      },
      { view: "histogram", values: [{ entity_id: ENTITY_ID, bins: BINS }] },
    ],
  };
  return normalizeMetricResults([result]).get("git.pr_cycle_time_h")!;
}

const meta: Meta<typeof MetricHistogram> = {
  title: "Widgets/MetricViews/MetricHistogram",
  component: MetricHistogram,
  args: { metric: drilldownMetric(), entityId: ENTITY_ID },
  decorators: [
    (Story) => (
      <EvidenceDialogContext.Provider
        value={{
          openEvidence: fn(),
          openEvidenceTargets: fn(),
          openEvidencePeople: fn(),
        }}
      >
        <Story />
      </EvidenceDialogContext.Provider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof MetricHistogram>;

export const Default: Story = {};

function expectHeadlineClearOfActions(canvasElement: HTMLElement) {
  const button = canvasElement.querySelector<HTMLElement>(
    '[aria-label^="More actions for"]',
  );
  const headline = [
    ...canvasElement.querySelectorAll<HTMLElement>("span"),
  ].find((span) => span.textContent?.trim().startsWith("Median"));

  expect(button, "the card renders its actions button").not.toBeNull();
  expect(headline, "the card renders its median headline").not.toBeUndefined();

  const label = document.createRange();
  label.selectNodeContents(headline!.firstChild!);
  const value = headline!.querySelector("span")!.getBoundingClientRect();

  expect(
    value.left - label.getBoundingClientRect().right,
    'the space between "Median" and its value is drawn',
  ).toBeGreaterThan(1);

  const buttonBox = button!.getBoundingClientRect();
  const headlineBox = headline!.getBoundingClientRect();

  expect(
    Math.round(buttonBox.left - headlineBox.right),
    `the ⋯ button starts after the median value ends (button ${Math.round(
      buttonBox.left,
    )}–${Math.round(buttonBox.right)}, value ${Math.round(
      headlineBox.left,
    )}–${Math.round(headlineBox.right)})`,
  ).toBeGreaterThan(0);

  const glyph = button!.querySelector("svg")!.getBoundingClientRect();
  const centre = (box: DOMRect) => box.top + box.height / 2;

  expect(
    Math.round(Math.abs(centre(glyph) - centre(headlineBox))),
    `the ⋯ glyph sits on the median's centre line (glyph ${Math.round(
      centre(glyph),
    )}, value ${Math.round(centre(headlineBox))})`,
  ).toBeLessThanOrEqual(1);
}

function expectSubtitleOnOneLine(canvasElement: HTMLElement) {
  const subtitle = canvasElement.querySelector<HTMLElement>(
    "span.truncate + span",
  )!;
  const lineHeight = parseFloat(getComputedStyle(subtitle).lineHeight);

  expect(
    Math.round(subtitle.getBoundingClientRect().height / lineHeight),
    `the subtitle "${subtitle.textContent}" stays on one line`,
  ).toBe(1);
}

export const TestHeadlineClearOfActionsWide: Story = {
  tags: ["test"],
  decorators: [
    (Story) => (
      <div className="w-[428px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    expectSubtitleOnOneLine(canvasElement);
    expectHeadlineClearOfActions(canvasElement);
  },
};

export const TestHeadlineClearOfActionsNarrow: Story = {
  tags: ["test"],
  decorators: [
    (Story) => (
      <div className="w-[326px]">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    expectHeadlineClearOfActions(canvasElement);
  },
};
