import type { Preview } from "@storybook/react-vite";
import { initialize, mswLoader } from "msw-storybook-addon";
import { configure } from "storybook/test";

import "@/index.css";
import { authStore } from "@/auth/auth-store";
import { themeDecorators } from "@/test/storybook/theme-decorators";
import { WithProviders } from "@/test/storybook/with-providers";

initialize({ onUnhandledRequest: "bypass" });

const STORY_WAIT_MS = 5000;

// WORKAROUND: Testing Library's 1 s default wait is tuned for jsdom; a story's
// first data arrives through the MSW worker and a query, on a shared runner.
configure({ asyncUtilTimeout: STORY_WAIT_MS });

const preview: Preview = {
  // WORKAROUND: Storybook tags every story `test`; only stories that re-add it run as tests.
  tags: ["!test"],
  parameters: {
    layout: "centered",
    docs: {
      stories: {
        filter: (story: { name: string }) => !story.name.startsWith("Test"),
      },
    },
  },
  beforeEach: () => {
    authStore.reset();
    try {
      window.localStorage.clear();
    } catch {
      // WORKAROUND: localStorage throws when storage is blocked; nothing to reset.
    }
  },
  loaders: [mswLoader],
  decorators: [...themeDecorators, WithProviders],
};

export default preview;
