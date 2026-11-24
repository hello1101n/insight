import { createTelemetry, type TelemetryService } from "@gears-frontx/telemetry";

import { getUsageConfig } from "@/api/usage-client";
import type { Session } from "@/auth/types";

const BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api/analytics/v1";

export const APP_NAME = "insight-frontend";

export const APP_VERSION =
  (import.meta.env.VITE_APP_RELEASE as string | undefined) || "0.0.0";

let service: TelemetryService | null = null;

const pending: Array<{ name: string; data: Record<string, unknown> }> = [];
const MAX_PENDING = 50;

function emit(name: string, data: Record<string, unknown>): void {
  if (service) {
    service.logEvent(name, data);
    return;
  }
  if (pending.length < MAX_PENDING) pending.push({ name, data });
}

export async function startUsageTelemetry(session: Session): Promise<void> {
  if (service || session.impersonatorEmail) return;

  const config = await getUsageConfig().catch(() => null);
  if (!config?.enabled) {
    pending.length = 0;
    return;
  }

  service = createTelemetry({
    appName: APP_NAME,
    appVersion: APP_VERSION,
    url: `${BASE}/usage/events`,
    apiVersion: 2,
    autocapture: false,
    // WORKAROUND: the SDK keeps one session per origin, so two people on one browser would merge.
    storagePrefix: `insight-usage:${session.personId}`,
  })
    .identify(session.personId)
    .start();

  for (const event of pending.splice(0)) {
    service.logEvent(event.name, event.data);
  }
}

const CUSTOM_PAGES = new Set([
  "metrics",
  "widgets",
  "datasets",
  "alerts",
  "destinations",
  "edit",
  "new",
]);

export function screenPath(path: string): string {
  const segments = path.split("/");
  return segments
    .map((segment, i) =>
      segments[i - 1] === "people" ||
      isDashboardId(segments, i) ||
      isIdentifier(segment)
        ? ":id"
        : segment,
    )
    .join("/");
}

function isDashboardId(segments: readonly string[], i: number): boolean {
  const segment = segments[i] ?? "";
  if (segment === "") return false;

  const page = segments[i - 1] === "dashboards";
  const editor =
    segments[i - 3] === "dashboards" &&
    segments[i - 2] === "edit" &&
    segments[i - 1] === "dashboards";

  return (page && !CUSTOM_PAGES.has(segment)) || editor;
}

function isIdentifier(segment: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
    /^\d{6,}$/.test(segment)
  );
}

let lastPath = "";

export function recordPageView(path: string): void {
  lastPath = screenPath(path);
  emit("page_view", { path: lastPath });
}

export function scopeLabel(scope: {
  root: string | null;
  directOnly: boolean;
  attrFilter?: { key: string; value: string };
}): string {
  if (scope.attrFilter) return `attr:${scope.attrFilter.key}`;
  if (!scope.root) return "whole-org";
  return scope.directOnly ? "subtree-direct" : "subtree";
}

export function recordUsageEvent(name: string, target: string): void {
  emit(name, { target, path: lastPath });
}

export function currentScreen(): string {
  return lastPath;
}
