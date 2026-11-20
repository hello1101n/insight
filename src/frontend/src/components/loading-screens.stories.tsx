import type { Meta, StoryObj } from "@storybook/react-vite";

import { AppBootSpinner } from "@/components/app-boot-spinner";
import { FullScreenLoading } from "@/components/full-screen-loading";

const meta: Meta<typeof FullScreenLoading> = {
  title: "Components/LoadingScreens",
  component: FullScreenLoading,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof FullScreenLoading>;

/** What the auth gate shows until a session is in hand. */
export const SigningIn: Story = { args: { message: "Redirecting to sign in…" } };

/** What a route shows while it loads. */
export const Booting: Story = { render: () => <AppBootSpinner /> };
