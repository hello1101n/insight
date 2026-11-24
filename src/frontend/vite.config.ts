import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { execSync } from "child_process";
import path from "path";
import { defineConfig, loadEnv } from "vite";

import { backendProxy } from "./vite.backend-proxy";
import { uiKitLayer } from "./vite.ui-kit-layer";

function localRelease(): string | undefined {
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    return `local-${sha}`;
  } catch {
    return undefined;
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const release = env.VITE_APP_RELEASE || localRelease();
  // WORKAROUND: process.env stores an assigned undefined as the string "undefined".
  if (release) process.env.VITE_APP_RELEASE = release;
  return {
    base: "./",
    plugins: [
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
      uiKitLayer(),
      backendProxy(env),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
});
