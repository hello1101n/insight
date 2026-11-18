import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect } from "storybook/test";
import type { CSSProperties } from "react";

import { BASE, type FolderList } from "@/api/custom-client";
import { SidebarProvider } from "@gears-frontx/ui-kit";
import { handlers } from "@/mocks/handlers";
import { expectHorizontallyContained } from "@/test/storybook/layout";

import { ShellSidebar } from "./portal-layout";

const LONG_FOLDER = "A folder with a name far longer than the pane";

const FOLDERS: FolderList = {
  folders: [
    {
      id: "f-1",
      name: LONG_FOLDER,
      owner_person_id: "p-1",
      access: "owner",
      dashboards: 128,
    },
    {
      id: "f-2",
      name: "Quarterly",
      owner_person_id: "p-1",
      access: "owner",
      dashboards: 3,
    },
  ],
  unfiled: 0,
};

const meta: Meta<typeof ShellSidebar> = {
  title: "Portal/ShellSidebar",
  component: ShellSidebar,
  parameters: {
    layout: "fullscreen",
    zone: "custom",
    msw: {
      handlers: [
        http.get(`${BASE}/folders`, () => HttpResponse.json(FOLDERS)),
        ...handlers,
      ],
    },
  },
  decorators: [
    (Story) => (
      <SidebarProvider
        style={
          {
            "--rail-width": "calc(var(--sidebar-width-icon) + 1px)",
            "--sidebar-width": "calc(var(--rail-width) + 16rem)",
          } as CSSProperties
        }
      >
        <Story />
      </SidebarProvider>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof ShellSidebar>;

export const Default: Story = {};

export const TestALongRowTitleTruncatesInsideThePane: Story = {
  tags: ["test"],
  play: async ({ canvas }) => {
    const title = await canvas.findByText(LONG_FOLDER);
    const pane = canvas.getByRole("navigation", {
      name: "Section navigation",
    }).parentElement!;
    const shell = pane.closest("[data-side]")!;
    const count = canvas.getByText("128");

    expectHorizontallyContained(shell, [pane, title, count], (element) =>
      element === pane ? "Context pane" : (element.textContent ?? "")
    );
    await expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
  },
};
