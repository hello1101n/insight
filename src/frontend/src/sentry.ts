import * as Sentry from "@sentry/react";

import { runtimeConfig } from "@/lib/runtime-config";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function initSentry(router: unknown): void {
  const dsn = runtimeConfig().sentryDsn ?? import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  try {
    Sentry.init({
      dsn,
      environment: resolveEnvironment(),
      release: import.meta.env.VITE_APP_RELEASE || undefined,
      integrations: [Sentry.tanstackRouterBrowserTracingIntegration(router)],
      tracesSampleRate: 0.1,
    });
  } catch (error) {
    console.error("Sentry init failed", error);
  }
}

function resolveEnvironment(): string {
  const { hostname } = window.location;
  return LOCAL_HOSTNAMES.has(hostname) ? "local" : hostname;
}
