import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";

import "./index.css";
import {
  authStore,
  clearAuthErrorAttempts,
  consumeAuthErrorParam,
  consumeOverrideParam,
  loadSession,
  signIn,
  startSessionRefresh,
} from "@/auth";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { LoginError } from "@/components/login-error";
import { ThemeProvider } from "@/components/theme-provider";
import i18n from "@/i18n";
import { queryClient } from "@/query-client";
import { initSentry } from "@/sentry";
import { startUsageTelemetry } from "@/telemetry";
import { recordScreens } from "@/usage-collection";
import { router } from "./router";

async function enableMocking(): Promise<void> {
  if (!import.meta.env.DEV) return;
  if (import.meta.env.VITE_ENABLE_MOCKS !== "true") return;
  const { worker } = await import("@/mocks/browser");
  await worker.start({ onUnhandledRequest: "bypass" });
}

initSentry(router);

if (!consumeOverrideParam()) bootstrap();

function bootstrap(): void {
  const authError = consumeAuthErrorParam();
  void enableMocking()
    .then(() => loadSession())
    .then((status) => {
      if (status === "authenticated") {
        clearAuthErrorAttempts();
        startSessionRefresh();
        startUsageCollection();
        renderApp();
        return;
      }
      if (authError?.autoRetry) {
        signIn();
        return;
      }
      if (authError) {
        renderLoginError(authError.code);
        return;
      }
      renderApp();
    });
}

function startUsageCollection(): void {
  const { session } = authStore.getSnapshot();
  if (!session) return;
  recordScreens(router);
  void startUsageTelemetry(session);
}

function renderApp(): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppErrorBoundary>
          <ThemeProvider>
            <I18nextProvider i18n={i18n}>
              <RouterProvider router={router} />
            </I18nextProvider>
          </ThemeProvider>
        </AppErrorBoundary>
      </QueryClientProvider>
    </StrictMode>
  );
}

function renderLoginError(code: string): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <I18nextProvider i18n={i18n}>
          <LoginError code={code} />
        </I18nextProvider>
      </ThemeProvider>
    </StrictMode>
  );
}
