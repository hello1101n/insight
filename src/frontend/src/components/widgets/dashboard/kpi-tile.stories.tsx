import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import type { KpiTileData } from "@/lib/insight/kpi-row";

import { KpiTile } from "./kpi-tile";

function makeTile(overrides: Partial<KpiTileData> = {}): KpiTileData {
  return {
    key: "tasks.closed",
    label: "Bugs Fixed",
    value: "12",
    delta: { text: "+9%", status: "good", down: false },
    medianLabel: "median 6",
    gapText: null,
    gapStatus: "neutral",
    groupId: "task_delivery",
    ...overrides,
  };
}

const meta: Meta<typeof KpiTile> = {
  title: "Widgets/Dashboard/KpiTile",
  component: KpiTile,
  decorators: [
    (Story) => (
      <div className="w-72">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof KpiTile>;

export const Default: Story = {
  args: { tile: makeTile(), periodNoun: "month" },
};

export const TestOkTile: Story = {
  tags: ["test"],
  args: { tile: makeTile(), periodNoun: "month" },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Bugs Fixed")).toBeInTheDocument();
    await expect(canvas.getByText("12")).toBeInTheDocument();
    await expect(canvas.getByText(/\+9% since last month/)).toBeInTheDocument();
    await expect(canvas.getByText(/team median 6/i)).toBeInTheDocument();
  },
};

export const TestNoPeers: Story = {
  tags: ["test"],
  args: {
    tile: makeTile({ gapStatus: "neutral", medianLabel: null, delta: null }),
    periodNoun: "month",
  },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("Bugs Fixed")).toBeInTheDocument();
    await expect(canvas.getByText(/no comparison/i)).toBeInTheDocument();
    await expect(canvas.queryByText(/median/i)).not.toBeInTheDocument();
  },
};
