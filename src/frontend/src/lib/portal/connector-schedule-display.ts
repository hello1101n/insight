import i18n from "@/i18n";

import type {
  ConnectorSchedule,
  InheritedSchedule,
  ScheduleOrigin,
  SchedulePendingReason,
} from "@/api/connector-health-client";
import { scheduleWords } from "./connector-schedule-editor";
import { scheduleRuns, scheduleTime } from "./connector-schedule-time";

function cronExpressionCount(crons: string[]): string {
  return i18n.t("connectors.schedule.concise.expressions", {
    count: crons.length,
  });
}

export function conciseScheduleWords(crons: string[]): string {
  const words = scheduleWords(crons, true) ?? cronExpressionCount(crons);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function deploymentScheduleLines(
  inherited: InheritedSchedule | null | undefined,
  nextCheck?: string | null
): string[] {
  if (!inherited) return [deploymentScheduleAvailability(nextCheck)];
  return [
    i18n.t("connectors.schedule.with_utc", {
      words: conciseScheduleWords(inherited.crons),
    }),
    ...inherited.crons.map((cron) =>
      i18n.t("connectors.schedule.with_utc", { words: cron })
    ),
    inherited.origin === "default"
      ? i18n.t("connectors.schedule.editor_reset_default")
      : deploymentScheduleSentence("reset", inherited.origin),
  ];
}

export function deploymentScheduleSentence(
  kind: "inherited" | "reset" | "override",
  origin: ScheduleOrigin
): string {
  return i18n.t(`connectors.schedule.deployment_${kind}.${origin}`);
}

export function schedulePendingSentence(
  reason: SchedulePendingReason | null | undefined
): string | null {
  switch (reason) {
    case "no_cronworkflow":
    case "different_schedule":
      return i18n.t(`connectors.schedule.pending_reason.${reason}`);
    case "awaiting_reconcile":
    case null:
    case undefined:
      return null;
  }
}

export function deploymentScheduleAvailability(nextCheck?: string | null) {
  return nextCheck
    ? i18n.t("connectors.schedule.shown_after", {
        time: scheduleTime(nextCheck),
      })
    : i18n.t("connectors.schedule.deployment_unrecorded");
}

export function scheduleStartHint(schedule: ConnectorSchedule) {
  if (schedule.pending_reason === "awaiting_reconcile")
    return deploymentScheduleAvailability(schedule.next_reconcile_at);
  return schedule.next_reconcile_at
    ? i18n.t("connectors.schedule.starts_by", {
        time: scheduleTime(schedule.next_reconcile_at),
      })
    : i18n.t("connectors.schedule.next_pass");
}

export function scheduleUntilThen(live: ConnectorSchedule["live"]) {
  if (!live) return i18n.t("connectors.schedule.no_job_until_then");
  const schedule =
    live.timezone === "UTC"
      ? runningScheduleInUtc(live.crons)
      : i18n.t("connectors.schedule.with_timezone", {
          crons: live.crons.join("; "),
          timezone: live.timezone ?? i18n.t("connectors.controller_time"),
        });
  return i18n.t("connectors.schedule.until_then", {
    schedule: live.suspended
      ? i18n.t("connectors.schedule_suspended", { timezone: schedule })
      : schedule,
  });
}

function runningScheduleInUtc(crons: string[]): string {
  const words = scheduleWords(crons, true);
  return words
    ? i18n.t("connectors.schedule.with_utc", { words: words.toLowerCase() })
    : i18n.t("connectors.schedule.expression_count_with_utc", {
        expressions: cronExpressionCount(crons),
      });
}

export function scheduleIsOverdue(
  schedule: ConnectorSchedule,
  fallbackInterval?: number | null,
  now = new Date()
): boolean {
  const interval = schedule.reconcile_interval_secs ?? fallbackInterval;
  return (
    schedule.status === "pending" &&
    schedule.requested != null &&
    interval != null &&
    interval > 0 &&
    now.getTime() - new Date(schedule.requested.updated_at).getTime() >=
      interval * 2000
  );
}

export function scheduleTransitionMessage(
  schedule: ConnectorSchedule,
  now = new Date()
): string {
  if (schedule.status !== "applied") return "";
  const live = schedule.live;
  const next =
    live?.timezone && !live.suspended
      ? scheduleRuns(live.crons, live.timezone, now)[0]
      : null;
  return next
    ? i18n.t("connectors.schedule.applied_next", {
        time: scheduleTime(next, now),
      })
    : i18n.t("connectors.schedule.applied_message");
}
