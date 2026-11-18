import i18n from "@/i18n";

import type {
  ConnectorSchedule,
  InheritedSchedule,
  SchedulePendingReason,
  ScheduleRequestState,
} from "@/api/connector-health-client";
import { isScheduleOverride } from "@/lib/portal/connector-schedule";
import { scheduleStatusView } from "@/lib/portal/connector-schedule-status";
import { scheduleTime } from "./connector-schedule-time";

export function schedulePendingWords(
  reason: SchedulePendingReason | null | undefined
): string | null {
  switch (reason) {
    case "no_cronworkflow":
      return i18n.t("connectors.schedule.pending_reason.no_cronworkflow");
    case "awaiting_reconcile":
      return i18n.t("connectors.schedule.pending_reason.awaiting_reconcile");
    case "different_schedule":
      return i18n.t("connectors.schedule.pending_reason.different_schedule");
    case null:
    case undefined:
      return null;
  }
}

function deploymentLines(
  inherited: InheritedSchedule | null | undefined,
  kind: "inherited" | "reset" | "override"
): string[] {
  if (!inherited) return [i18n.t("connectors.schedule.deployment_unrecorded")];

  const source =
    inherited.origin === "annotation"
      ? i18n.t("connectors.schedule.origin.annotation")
      : inherited.origin === "descriptor"
        ? i18n.t("connectors.schedule.origin.descriptor")
        : inherited.origin === "default"
          ? i18n.t("connectors.schedule.origin.default")
          : inherited.origin;
  return [
    i18n.t(`connectors.schedule.deployment_${kind}`, { source }),
    ...inherited.crons.map((cron) =>
      i18n.t("connectors.schedule.with_utc", { words: cron })
    ),
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

  if (schedule.read_error) return [schedule.read_error];

  const { live, inherited, revision } = schedule;
  const running = live
    ? [
        i18n.t("connectors.schedule.runs_checked", {
          time: scheduleTime(live.observed_at),
        }),
        ...live.crons.map(
          (cron) =>
            `${cron} ${live.timezone ?? i18n.t("connectors.controller_time")}`
        ),
      ]
    : [];
  switch (schedule.status) {
    case "paused":
      return [i18n.t("connectors.schedule.paused_detail")];
    case "inherited":
      return deploymentLines(inherited, "inherited");
    case "pending": {
      const requested = schedule.requested;
      const request = isScheduleOverride(requested)
        ? i18n.t("connectors.schedule.request_author", {
            revision,
            person,
            time: scheduleTime(requested.updated_at),
          })
        : i18n.t("connectors.schedule.request_revision", { revision });
      const reason = schedulePendingWords(schedule.pending_reason);
      return [
        request,
        ...(reason
          ? [i18n.t("connectors.schedule.reason_sentence", { reason })]
          : []),
        ...(schedule.next_reconcile_at
          ? [
              i18n.t("connectors.schedule.next_reconcile", {
                time: scheduleTime(schedule.next_reconcile_at),
              }),
            ]
          : []),
        ...(requested && !isScheduleOverride(requested)
          ? deploymentLines(inherited, "reset")
          : []),
        ...running,
      ];
    }
    case "applied":
      return [
        ...(live
          ? [
              i18n.t("connectors.schedule.request_running", {
                revision,
                time: scheduleTime(live.observed_at),
              }),
              ...live.crons.map(
                (cron) =>
                  `${cron} ${live.timezone ?? i18n.t("connectors.controller_time")}`
              ),
            ]
          : [i18n.t("connectors.schedule.live_unrecorded")]),
        ...deploymentLines(inherited, "override"),
      ];
    case null:
      return [i18n.t("connectors.schedule.live_unreadable")];
  }
}
