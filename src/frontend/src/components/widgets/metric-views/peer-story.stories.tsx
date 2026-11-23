import type { Meta, StoryObj } from "@storybook/react-vite";

import { PeerStory } from "@/components/widgets/metric-views/peer-story";
import type { PeerStoryEntry } from "@/lib/metrics/peer-story";
import type { PeerStatusWithNeutral } from "@/lib/peers";
import { CARD_PX_WIDE } from "@/test/storybook/layout";

function entry(
  key: string,
  label: string,
  value: number,
  median: number,
  status: PeerStatusWithNeutral
): PeerStoryEntry {
  const gapDelta = value - median;
  const gapPct = gapDelta / median;

  return {
    key,
    label,
    value,
    unit: null,
    format: "integer",
    higherIsBetter: true,
    neutral: status === "neutral",
    observed: true,
    stats: {
      p25: median * 0.7,
      p50: median,
      p75: median * 1.3,
      min: median * 0.2,
      max: median * 2,
      n: 14,
    },
    status,
    gapPct,
    gapDelta,
    severity: Math.abs(gapPct),
  };
}

const OUTLIERS = [
  entry("prs", "PRs merged", 3, 9, "bottom"),
  entry("reviews", "Reviews given", 28, 12, "top"),
  entry("commits", "Commits", 14, 30, "bottom"),
  entry("lines", "Lines added", 4200, 2600, "top"),
];

const IN_PACK = [
  entry("comments", "Review comments", 22, 20, "in_pack"),
  entry("repos", "Repositories touched", 4, 4, "neutral"),
];

const meta: Meta<typeof PeerStory> = {
  title: "Widgets/MetricViews/PeerStory",
  component: PeerStory,
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_WIDE }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof PeerStory>;

/** Outliers lead with the furthest one; the rest fold under them. */
export const Standing: Story = { args: { entries: [...OUTLIERS, ...IN_PACK] } };

/** Nobody sits outside the pack, so every metric gets the same card. */
export const FlatGrid: Story = { args: { entries: IN_PACK } };

export const Empty: Story = { args: { entries: [] } };
