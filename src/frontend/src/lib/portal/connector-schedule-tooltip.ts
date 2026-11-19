import i18n from "@/i18n";

import type {
  ConnectorSchedule,
  InheritedSchedule,
  ScheduleRequestState,
} from "@/api/connector-health-client";
import { isScheduleOverride } from "@/lib/portal/connector-schedule";
import { scheduleStatusView } from "@/lib/portal/connector-schedule-status";
import {
  deploymentScheduleAvailability,
  deploymentScheduleSentence,
  schedulePendingSentence,
  scheduleStartHint,
} from "./connector-schedule-display";
import { scheduleTime, scheduleTimePhrase } from "./connector-schedule-time";

function deploymentLines(
  inherited: InheritedSchedule,
  kind: "inherited" | "reset" | "override",
  runningCrons: string[] = []
): string[] {
  const crons = inherited.crons.map((cron) =>
    i18n.t("connectors.schedule.with_utc", { words: cron })
  );
  const target = new Set(crons);
  const running = new Set(runningCrons);
  const matches =
    target.size === running.size &&
    [...target].every((cron) => running.has(cron));
  return [
    deploymentScheduleSentence(kind, inherited.origin),
    ...(matches ? [] : crons),
  ];
}

export function scheduleTooltipLines(
  schedule: ConnectorSchedule | ScheduleRequestState | undefined,
  person = i18n.t("connectors.schedule.another_admin")
): string[] {
  if (!schedule) return [i18n.t("connectors.schedule.not_loaded")];

  if (schedule.read_error) return [schedule.read_error];

  if (!("status" in schedule)) {
    const observation = schedule.last_observation;
    if (!observation) return [i18n.t("connectors.schedule.not_loaded")];

    const { label } = scheduleStatusView(observation.status);
    return [i18n.t("connectors.schedule.details_loading", { label })];
  }

  const { live, inherited, requested } = schedule;
  const author = isScheduleOverride(requested)
    ? [
        i18n.t("connectors.schedule.request_author", {
          person,
          time: scheduleTimePhrase(requested.updated_at),
        }),
      ]
    : [];
  const runningCrons =
    live?.crons.map(
      (cron) =>
        `${cron} ${live.timezone ?? i18n.t("connectors.controller_time")}`
    ) ?? [];
  const running = live
    ? [
        i18n.t("connectors.schedule.runs_checked", {
          time: scheduleTime(live.observed_at),
        }),
        ...runningCrons,
      ]
    : [];
  switch (schedule.status) {
    case "paused":
      return [i18n.t("connectors.schedule.paused_detail")];
    case "inherited":
      return inherited
        ? deploymentLines(inherited, "inherited")
        : [deploymentScheduleAvailability(schedule.next_reconcile_at)];
    case "pending": {
      const reason = schedulePendingSentence(schedule.pending_reason);
      return [
        ...author,
        ...(reason ? [reason] : []),
        scheduleStartHint(schedule),
        ...(inherited && requested && !isScheduleOverride(requested)
          ? deploymentLines(inherited, "reset", runningCrons)
          : []),
        ...(live ? running : [i18n.t("connectors.schedule.no_job_until_then")]),
      ];
    }
    case "applied":
      return [
        ...author,
        ...(live ? running : [i18n.t("connectors.schedule.live_unrecorded")]),
        ...(inherited ? deploymentLines(inherited, "override") : []),
      ];
    case null:
      return [i18n.t("connectors.schedule.live_unreadable")];
  }
}
