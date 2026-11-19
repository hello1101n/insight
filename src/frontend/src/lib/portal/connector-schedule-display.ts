import i18n from "@/i18n";

import type {
  ConnectorSchedule,
  InheritedSchedule,
} from "@/api/connector-health-client";
import { scheduleWords } from "./connector-schedule-editor";
import { scheduleClock, scheduleRuns } from "./connector-schedule-time";

export function conciseScheduleWords(crons: string[]): string {
  const words =
    scheduleWords(crons, true) ?? i18n.t("connectors.schedule.custom");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function deploymentScheduleLines(
  inherited: InheritedSchedule | null | undefined
): string[] {
  if (!inherited) return [i18n.t("connectors.schedule.deployment_unrecorded")];
  const source =
    inherited.origin === "annotation"
      ? i18n.t("connectors.schedule.origin.annotation_short")
      : inherited.origin === "descriptor"
        ? i18n.t("connectors.schedule.origin.descriptor")
        : inherited.origin === "default"
          ? i18n.t("connectors.schedule.origin.default")
          : inherited.origin;
  return [
    i18n.t("connectors.schedule.with_utc", {
      words: conciseScheduleWords(inherited.crons),
    }),
    ...inherited.crons.map((cron) =>
      i18n.t("connectors.schedule.with_utc", { words: cron })
    ),
    i18n.t("connectors.schedule.from_source", { source }),
  ];
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
    ? i18n.t("connectors.schedule.applied_next", { time: scheduleClock(next) })
    : i18n.t("connectors.schedule.applied_message");
}
