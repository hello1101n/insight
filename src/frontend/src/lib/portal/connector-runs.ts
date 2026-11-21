import type { ConnectorRun } from "@/api/connector-health-client";
import i18n from "@/i18n";
import {
  elapsedMs,
  formatDuration,
  UNMEASURED,
  type ConnectorTone,
} from "./connector-health";

const statuses = {
  running: "active",
  queued: "idle",
  waiting_pod: "idle",
  placement_overdue: "failing",
  stopping_pod_wait: "failing",
  waiting_clickhouse: "idle",
  loading: "active",
  transforming: "active",
  checking_start: "unknown",
  wait_warning: "unknown",
  wait_timeout: "failing",
  succeeded: "ok",
  failed: "failing",
  cancelled: "idle",
  unknown: "unknown",
} as const satisfies Record<string, ConnectorTone>;

export function describeRun(status: string) {
  const state = Object.hasOwn(statuses, status)
    ? (status as keyof typeof statuses)
    : "unknown";
  return {
    state,
    tone: statuses[state],
    label: i18n.t(`connectors.runs.${state}`),
  };
}

const terminal = new Set(["succeeded", "failed", "cancelled", "wait_timeout"]);

export function isActiveRun(run: ConnectorRun): boolean {
  return run.finished_at == null && !terminal.has(run.status);
}

export function runDuration(run: ConnectorRun, asOf: string): string {
  const duration =
    run.duration_ms ??
    (isActiveRun(run) && describeRun(run.status).state !== "unknown"
      ? elapsedMs(asOf, run.started_at)
      : null);
  const text = formatDuration(duration);
  if (!isActiveRun(run) || text === UNMEASURED) return text;
  return i18n.t("connectors.so_far", { duration: text });
}
