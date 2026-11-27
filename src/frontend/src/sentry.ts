import * as Sentry from "@sentry/react";

import { runtimeConfig } from "@/lib/runtime-config";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// SAFETY: a FrontX console line can quote answer values and host error text, so no event carries it as a breadcrumb.
const FRONTX_CONSOLE_LINE = /^\[(dashboard|widget)\] /;

export function initSentry(router: unknown): void {
  const dsn = sentryDsn(
    runtimeConfig().sentryDsn,
    import.meta.env.VITE_SENTRY_DSN
  );
  if (dsn === null) return;

  try {
    Sentry.init({
      dsn,
      environment: resolveEnvironment(),
      release: import.meta.env.VITE_APP_RELEASE || undefined,
      integrations: [Sentry.tanstackRouterBrowserTracingIntegration(router)],
      tracesSampleRate: 0.1,
      beforeBreadcrumb: (breadcrumb) =>
        breadcrumb.category === "console" &&
        FRONTX_CONSOLE_LINE.test(breadcrumb.message ?? "")
          ? null
          : breadcrumb,
    });
  } catch (error) {
    console.error("Sentry init failed", error);
  }
}

function sentryDsn(
  runtime: string | undefined,
  build: string | undefined
): string | null {
  if (runtime != null) return runtime || null;
  return build || null;
}

function resolveEnvironment(): string {
  const { hostname } = window.location;
  return LOCAL_HOSTNAMES.has(hostname) ? "local" : hostname;
}
