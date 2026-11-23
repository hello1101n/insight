import type {
  ConnectorRun,
  ConnectorRunStage,
} from "@/api/connector-health-client";
import i18n from "@/i18n";
import {
  elapsedMs,
  formatDuration,
  parseStamp,
  UNMEASURED,
  type ConnectorTone,
} from "./connector-health";

export const RUN_STEPS = ["bronze", "silver", "identity", "gold"] as const;
export type RunStep = (typeof RUN_STEPS)[number];

const steps = new Map<string, RunStep>([
  ["bronze", "bronze"],
  ["transform-staging", "silver"],
  ["transform-jira-staging", "silver"],
  ["identity-seed", "identity"],
  ["transform-legacy", "gold"],
  ["transform-jira-silver", "gold"],
]);

export const stepForStage = (stage: string) => steps.get(stage);
export const stepLabel = (step: RunStep) =>
  i18n.t(`connectors.runs.step.${step}.label`);
export const stepDetail = (step: RunStep) =>
  i18n.t(`connectors.runs.step.${step}.detail`);

const states = {
  running: ["running", "active"],
  queued: ["queued", "idle"],
  starting: ["queued", "idle"],
  waiting_admission: ["queued", "idle"],
  waiting_pod: ["queued", "idle"],
  placement_overdue: ["queued", "failing"],
  stopping_pod_wait: ["queued", "failing"],
  waiting_clickhouse: ["queued", "idle"],
  loading: ["running", "active"],
  transforming: ["running", "active"],
  checking_start: ["queued", "idle"],
  wait_warning: ["queued", "unknown"],
  wait_timeout: ["failed", "failing"],
  succeeded: ["succeeded", "ok"],
  failed: ["failed", "failing"],
  not_started: ["failed", "failing"],
  cancelled: ["cancelled", "idle"],
  unknown: ["unknown", "unknown"],
} as const satisfies Record<string, readonly [string, ConnectorTone]>;

export function describeRun(status: string) {
  const state = Object.hasOwn(states, status)
    ? (status as keyof typeof states)
    : "unknown";
  const [kind, tone] = states[state];
  const label =
    state === "loading"
      ? stepLabel("bronze")
      : i18n.t(`connectors.runs.${kind}`);
  return { state, kind, tone, label };
}

const failures = new Set(["failed", "not_started", "wait_timeout"]);
const terminal = new Set(["succeeded", "cancelled", ...failures]);
export const isTerminalRunStatus = (status: string) => terminal.has(status);
const HOUR_MS = 3_600_000;

const queryError = (stage: ConnectorRunStage) =>
  /^clickhouse_query_error:(\d+):([A-Z0-9_]+)$/.exec(stage.reason ?? "");

export function stageFailureReason(stage: ConnectorRunStage): string {
  const error = queryError(stage);
  if (error)
    return i18n.t(
      error[2] === "UNKNOWN_IDENTIFIER"
        ? "connectors.runs.reason.unknown_identifier"
        : "connectors.runs.reason.query_error"
    );
  if (stage.status === "wait_timeout")
    return i18n.t("connectors.runs.reason.wait_timeout");
  return stage.reason
    ? i18n.t(`connectors.runs.reason.${stage.reason}`, {
        defaultValue: i18n.t("connectors.runs.unfamiliar_failure_reason"),
      })
    : i18n.t("connectors.runs.no_failure_reason");
}

export function stageFailureDetails(stage: ConnectorRunStage): string[] {
  const error = queryError(stage);
  const details = [stage.stage];
  if (error)
    details.push(
      i18n.t("connectors.runs.query_error_detail", {
        code: error[1],
        name: error[2],
      })
    );
  else if (stage.reason) details.push(stage.reason);
  return details;
}

function latestStageAttempts(stages: ConnectorRunStage[]): ConnectorRunStage[] {
  const latest = new Map<string, ConnectorRunStage>();
  for (const stage of stages) {
    const previous = latest.get(stage.stage);
    if (!previous || stage.attempt >= previous.attempt)
      latest.set(stage.stage, stage);
  }
  return stages.filter((stage) => latest.get(stage.stage) === stage);
}

export function stepFailure(stages: ConnectorRunStage[]) {
  return latestStageAttempts(stages).findLast((stage) =>
    failures.has(stage.status)
  );
}

export function projectRun(run: ConnectorRun): ConnectorRun {
  const stages = run.stages.filter(
    (stage) => stage.stage !== "connector-checks"
  );
  const attempts = latestStageAttempts(stages);
  const failure = attempts.findLast((stage) => failures.has(stage.status));
  const gold = attempts.filter((stage) => stepForStage(stage.stage) === "gold");

  if (failure?.status === "not_started" || failure?.status === "wait_timeout") {
    const finished_at = failure.finished_at ?? run.finished_at;
    const duration_ms =
      elapsedMs(finished_at ?? "", run.started_at) ?? run.duration_ms;
    return { ...run, stages, status: failure.status, finished_at, duration_ms };
  }

  const goldCompleted =
    gold.length > 0 && gold.every((stage) => stage.status === "succeeded");
  const checksWithoutGold =
    gold.length === 0 && stages.length < run.stages.length;
  if (failure || (!goldCompleted && !checksWithoutGold))
    return stages.length === run.stages.length ? run : { ...run, stages };

  const ready = Math.max(
    ...gold.map((stage) => parseStamp(stage.finished_at) ?? NaN)
  );
  if (Number.isFinite(ready)) {
    const finished_at = new Date(ready).toISOString();
    const duration_ms = elapsedMs(finished_at, run.started_at);
    return { ...run, stages, status: "succeeded", finished_at, duration_ms };
  }

  if (run.status === "succeeded") return { ...run, stages };
  return {
    ...run,
    stages,
    status: "succeeded",
    finished_at: null,
    duration_ms: null,
  };
}

export type QueueReason = "memory" | "capacity";

export function queueTone(
  duration: number,
  tone: ConnectorTone
): ConnectorTone {
  if (tone === "failing" || duration > 6 * HOUR_MS) return "failing";
  if (tone === "unknown" || duration > 3 * HOUR_MS) return "unknown";
  return "idle";
}

export function queueReason(
  status: string | null | undefined
): QueueReason | undefined {
  switch (status) {
    case "waiting_clickhouse":
      return "memory";
    case "waiting_pod":
    case "placement_overdue":
    case "stopping_pod_wait":
      return "capacity";
  }
}

export function queueDetails(
  reasons: QueueReason[],
  tone: ConnectorTone
): string[] {
  const details = reasons.map((reason) =>
    i18n.t(`connectors.runs.queue_reason.${reason}`)
  );
  const severity = queueSeverity(tone);
  if (severity) details.push(severity);
  return details;
}

export function queueSeverity(tone: ConnectorTone) {
  if (tone === "unknown") return i18n.t("connectors.runs.queue_warning");
  if (tone === "failing") return i18n.t("connectors.runs.reason.wait_timeout");
  return null;
}

export function isActiveRun(run: ConnectorRun): boolean {
  return run.finished_at == null && !isTerminalRunStatus(run.status);
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
