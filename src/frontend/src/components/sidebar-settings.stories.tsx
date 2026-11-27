import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { SidebarProvider } from "@gears-frontx/ui-kit";

import { SETTINGS_POPOVER_CLASS } from "./portal/lens-rail";
import { SidebarSettings } from "./sidebar-settings";

const meta: Meta<typeof SidebarSettings> = {
  title: "Components/SidebarSettings",
  component: SidebarSettings,
  decorators: [
    (Story) => (
      <SidebarProvider>
        <div className={`${SETTINGS_POPOVER_CLASS} p-1`}>
          <Story />
        </div>
      </SidebarProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof SidebarSettings>;

function contentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (
    element.clientWidth -
    parseFloat(style.paddingInlineStart) -
    parseFloat(style.paddingInlineEnd)
  );
}

export const Default: Story = {};

export const TestToggleRowShowsItsWholeLabel: Story = {
  tags: ["test"],
  play: async ({ canvas }) => {
    const row = canvas.getByRole("button", { name: /planned sections/i });
    const children = [...row.children];
    const gap = parseFloat(getComputedStyle(row).columnGap);
    const used = children.reduce(
      (total, child) => total + child.getBoundingClientRect().width,
      gap * (children.length - 1),
    );
    const label = row.querySelector<HTMLElement>("span > span")!;

    await expect(used).toBeLessThanOrEqual(contentWidth(row));
    await expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
  },
};
