import type {
  ConnectorRun,
  ConnectorRunStage,
} from "@/api/connector-health-client";
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
  starting: "active",
  waiting_admission: "idle",
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

export function stageFailureReason(stage: ConnectorRunStage): string {
  const reason = stage.reason;
  const queryError = /^clickhouse_query_error:(\d+):([A-Z0-9_]+)$/.exec(
    reason ?? ""
  );
  if (queryError) {
    if (queryError[2] === "UNKNOWN_IDENTIFIER")
      return i18n.t("connectors.runs.unknown_identifier");
    return i18n.t("connectors.runs.query_error", {
      code: queryError[1],
      name: queryError[2],
    });
  }
  if (stage.status === "wait_timeout")
    return i18n.t("connectors.runs.reason.wait_timeout");
  if (reason && reason !== stage.status && reason !== "stage_failed")
    return i18n.t(`connectors.runs.reason.${reason}`, { defaultValue: reason });
  return i18n.t("connectors.runs.no_failure_reason");
}

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
