import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";

import { MetricTimeseriesTable } from "@/components/widgets/metric-views/metric-timeseries-table";
import { groupedTimeseriesModel } from "@/components/widgets/metric-views/metric-timeseries.test-fixtures";
import {
  CARD_PX_AT_390,
  expectNothingOverlaps,
} from "@/test/storybook/layout";

const SHORT_PX = 180;

const GUTTER_PX = 48;

const meta: Meta<typeof MetricTimeseriesTable> = {
  title: "Widgets/MetricViews/MetricTimeseriesTable",
  component: MetricTimeseriesTable,
  args: { model: groupedTimeseriesModel() },
};
export default meta;

type Story = StoryObj<typeof MetricTimeseriesTable>;

export const Default: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 900, height: 300 }}>
        <Story />
      </div>
    ),
  ],
};

function scrollControls(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('button[aria-label^="Show "]')
  );
}

function nameOf(element: Element): string {
  return element.getAttribute("aria-label") ?? "a scroll control";
}

export const TestShortTableKeepsItsControlsApart: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_AT_390, height: SHORT_PX }}>
        <Story />
      </div>
    ),
  ],
  tags: ["test"],
  play: async ({ canvasElement }) => {
    const table = canvasElement.querySelector("table")!;
    const scrollport = table.parentElement!;
    const controls = scrollControls(canvasElement);

    const labels = controls.map(nameOf);
    await expect(
      labels,
      `the table scrolls both ways, so it renders a control for each (${labels.join(", ")})`
    ).toEqual(
      expect.arrayContaining(["Show later columns", "Show later rows"])
    );

    expectNothingOverlaps(scrollport, controls, nameOf);
    for (const control of controls) {
      expectNothingOverlaps(
        control,
        controls.filter((other) => other !== control),
        nameOf
      );
    }
  },
};

export const TestNarrowTableLeavesRoomForAValueColumn: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_AT_390, height: 400 }}>
        <Story />
      </div>
    ),
  ],
  tags: ["test"],
  play: async ({ canvasElement }) => {
    const table = canvasElement.querySelector("table")!;
    const scrollport = table.parentElement!;
    const cells = Array.from(
      table.querySelectorAll<HTMLElement>("tbody tr:first-child > *")
    );

    await expect(
      cells.length,
      "the first row has a bucket cell and at least one value"
    ).toBeGreaterThan(1);

    const room = scrollport.clientWidth;
    const bucket = cells[0].getBoundingClientRect().width;
    const value = cells[1].getBoundingClientRect().width;
    await expect(
      Math.round(bucket + value),
      `the bucket column (${Math.round(bucket)}px) and the first value ` +
        `(${Math.round(value)}px) do not fit the ${room}px scrollport`
    ).toBeLessThanOrEqual(room);

    const date = cells[0];
    await expect(
      date.scrollWidth,
      `the bucket cell clips its date (${date.scrollWidth}px of text in ${date.clientWidth}px)`
    ).toBeLessThanOrEqual(date.clientWidth);
  },
};

export const TestWidenedTableReleasesItsGutters: Story = {
  decorators: [
    (Story) => (
      <div data-testid="box" style={{ width: CARD_PX_AT_390, height: 400 }}>
        <Story />
      </div>
    ),
  ],
  tags: ["test"],
  play: async ({ canvasElement }) => {
    const box = canvasElement.querySelector<HTMLElement>('[data-testid="box"]')!;
    const table = canvasElement.querySelector("table")!;
    const wrapper = table.parentElement!.parentElement!;

    await waitFor(() =>
      expect(
        scrollControls(canvasElement).length,
        "the narrow table scrolls sideways to begin with"
      ).toBeGreaterThan(0)
    );

    box.style.width = `${table.offsetWidth + GUTTER_PX}px`;

    await waitFor(() =>
      expect(
        scrollControls(canvasElement).map(nameOf),
        "the widened table still offers to scroll"
      ).toEqual([])
    );

    const scrollport = table.parentElement!;
    await expect(
      scrollport.scrollWidth,
      `the widened table still scrolls sideways (${scrollport.scrollWidth}px of table in ${scrollport.clientWidth}px)`
    ).toBeLessThanOrEqual(scrollport.clientWidth);
    await expect(
      wrapper.className,
      "the wrapper kept a gutter it no longer has a control for"
    ).not.toContain("ps-12");
  },
};
