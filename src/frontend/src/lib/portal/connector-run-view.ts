import type { ConnectorRun } from "@/api/connector-health-client";
import i18n from "@/i18n";

import { summarizeRun, type RunTiming } from "./connector-run-timing";
import {
  describeRun,
  isTerminalRunStatus,
  queueReason,
  stepFailure,
  stepForStage,
  stepLabel,
  type QueueReason,
} from "./connector-runs";

export function describeRunState(
  run: ConnectorRun,
  asOf: string,
  timing?: RunTiming
) {
  const view = describeRun(run.status);
  const current = run.stages.findLast(
    (stage) => !stage.finished_at && !isTerminalRunStatus(stage.status)
  );
  const failure = view.kind === "failed" ? stepFailure(run.stages) : undefined;
  const failedStep = failure && stepForStage(failure.stage);
  const currentStep = current && stepForStage(current.stage);
  const queue =
    view.kind === "queued"
      ? (timing ?? summarizeRun(run, asOf)).currentQueue
      : undefined;
  const reason =
    queueReason(current?.reason) ??
    queueReason(current?.status) ??
    queueReason(view.state);
  const fallbackReasons = new Set<QueueReason>(reason ? [reason] : []);
  if (
    current?.waits?.some((wait) => wait.kind === "placement" && !wait.ended_at)
  )
    fallbackReasons.add("capacity");

  let label = view.label;
  if (failedStep)
    label = i18n.t("connectors.runs.failed_step", {
      step: stepLabel(failedStep),
    });
  if (view.kind === "running" && currentStep) label = stepLabel(currentStep);

  return {
    ...view,
    label,
    tone: queue?.tone ?? view.tone,
    failure,
    queueReasons: queue?.reasons ?? [...fallbackReasons],
  };
}
