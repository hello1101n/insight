import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";

import { uiKitLayer } from "./vite.ui-kit-layer";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // WORKAROUND: the kit's JS imports its own .css, which node's ESM loader rejects.
    server: { deps: { inline: ["@gears-frontx/ui-kit"] } },
    // WORKAROUND: CI runs in UTC, where zone-less parsing tests pass vacuously.
    env: { TZ: "Pacific/Kiritimati" },
    // WORKAROUND: Vitest ignores a `coverage` block nested inside a project.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "cobertura"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/*.stories.{ts,tsx}",
        "src/test/**",
        "src/mocks/**",
        "src/**/*.d.ts",
        "src/routeTree.gen.ts",
        "src/main.tsx",
        "src/routes/**",
      ],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          globals: false,
          css: false,
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/**/*.test.ts", "src/**/*.test.tsx", "vite.*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [
          tailwindcss(),
          uiKitLayer(),
          storybookTest({
            configDir: path.resolve(__dirname, ".storybook"),
            tags: { include: ["test"], exclude: [], skip: ["skip-test"] },
          }),
        ],
        // WORKAROUND: Vite reloads the page when it discovers a dependency mid-run.
        optimizeDeps: {
          include: [
            "@gears-frontx/telemetry",
            "@gears-frontx/ui-kit",
            "@sentry/react",
            "@tanstack/react-virtual",
            "cronstrue",
            "exceljs",
            "react-error-boundary",
          ],
        },
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
