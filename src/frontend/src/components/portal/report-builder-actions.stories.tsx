import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";

import { Sidebar, SidebarInset, SidebarProvider } from "@gears-frontx/ui-kit";

import { ReportBuilderActions } from "./report-builder-actions";

const meta: Meta<typeof ReportBuilderActions> = {
  title: "Portal/ReportBuilderActions",
  component: ReportBuilderActions,
  parameters: { layout: "fullscreen" },
  args: {
    selectedCount: 2,
    hasSelection: true,
    blocker: null,
    running: false,
    failure: null,
    onClear: () => {},
    onCancel: () => {},
    onPreview: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof ReportBuilderActions>;

const inShell = (open: boolean): Story["decorators"] => [
  (Story) => (
    <SidebarProvider defaultOpen={open}>
      <Sidebar collapsible="icon">
        <div />
      </Sidebar>
      <SidebarInset data-testid="inset">
        <Story />
      </SidebarInset>
    </SidebarProvider>
  ),
];

const startsAtTheInset: Story["play"] = async ({ canvas, canvasElement }) => {
  const bar = canvas.getByRole("status").closest(".fixed")!;
  const inset = canvasElement.querySelector('[data-testid="inset"]')!;

  await expect(bar.getBoundingClientRect().left).toBeCloseTo(
    inset.getBoundingClientRect().left,
    0
  );
};

export const TestStartsBesideTheOpenSidebar: Story = {
  tags: ["test"],
  decorators: inShell(true),
  play: startsAtTheInset,
};

export const TestStartsBesideTheCollapsedSidebar: Story = {
  tags: ["test"],
  decorators: inShell(false),
  play: startsAtTheInset,
};
