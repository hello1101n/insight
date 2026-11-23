import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@gears-frontx/ui-kit";

import type { ConnectorRun } from "@/api/connector-health-client";
import type { RunTiming } from "@/lib/portal/connector-run-timing";
import { describeRunState } from "@/lib/portal/connector-run-view";
import {
  queueDetails,
  stageFailureDetails,
  stageFailureReason,
} from "@/lib/portal/connector-runs";
import { cn } from "@/lib/utils";
import { TONE_BADGE } from "./connector-health-tone";

export function RunTooltip({
  children,
  lines,
}: {
  children: ReactNode;
  lines: string[];
}) {
  const id = useId();
  if (!lines.length) return children;

  return (
    <Tooltip>
      <TooltipTrigger
        aria-describedby={id}
        render={
          <span tabIndex={0} onClick={(event) => event.stopPropagation()} />
        }
        className="cursor-help"
      >
        {children}
      </TooltipTrigger>
      <TooltipContent id={id} role="tooltip">
        <div className="flex flex-col gap-1">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export function ConnectorRunState({
  run,
  asOf,
  timing,
  showRunning = false,
}: {
  run: ConnectorRun;
  asOf: string;
  timing?: RunTiming;
  showRunning?: boolean;
}) {
  const { t } = useTranslation();
  const view = describeRunState(run, asOf, timing);
  const detail =
    view.kind === "queued"
      ? queueDetails(view.queueReasons, view.tone)
      : view.failure
        ? stageFailureDetails(view.failure)
        : [];

  const running = t("connectors.runs.running");
  const label =
    showRunning && view.kind === "running" && view.label !== running
      ? t("connectors.runs.running_step", { step: view.label })
      : view.label;
  const reason = view.failure
    ? stageFailureReason(view.failure)
    : view.state === "wait_timeout"
      ? t("connectors.runs.reason.wait_timeout")
      : null;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <RunTooltip lines={detail}>
        <Badge
          variant={TONE_BADGE[view.tone]}
          className="whitespace-normal"
        >
          {label}
        </Badge>
      </RunTooltip>
      {view.kind === "failed" && reason && (
        <span className="basis-full text-xs whitespace-normal text-muted-foreground">
          {reason}
        </span>
      )}
    </div>
  );
}
