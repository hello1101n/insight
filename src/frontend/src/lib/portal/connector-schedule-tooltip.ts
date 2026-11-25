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
  inheritedScheduleSentence,
  schedulePendingSentence,
  scheduleStartHint,
} from "./connector-schedule-display";
import {
  scheduleObservationTime,
  scheduleTimePhrase,
  scheduleTooltipTimePhrase,
} from "./connector-schedule-time";

interface ScheduleTooltipRow {
  kind: "running" | "target" | "deployment";
  label: string;
  qualifier: string;
  crons: string[];
  zone: string;
}

export interface ScheduleTooltipContent {
  status?: string;
  rows: ScheduleTooltipRow[];
}

function scheduleRow(
  kind: ScheduleTooltipRow["kind"],
  qualifier: string,
  crons: string[],
  zone = i18n.t("common.period.utc")
): ScheduleTooltipRow {
  return {
    kind,
    label: i18n.t(`connectors.schedule.tooltip.${kind}`),
    qualifier,
    crons,
    zone,
  };
}

function deploymentRow(
  kind: "target" | "deployment",
  schedule: InheritedSchedule
): ScheduleTooltipRow {
  return scheduleRow(
    kind,
    i18n.t(`connectors.schedule.tooltip.origin.${schedule.origin}`),
    schedule.crons
  );
}

export function resetScheduleTooltip(
  inherited: InheritedSchedule | null | undefined,
  nextCheck?: string | null
): ScheduleTooltipContent {
  return inherited
    ? { rows: [deploymentRow("target", inherited)] }
    : { status: deploymentScheduleAvailability(nextCheck), rows: [] };
}

function pendingTooltip(
  schedule: ConnectorSchedule,
  person: string,
  running: ScheduleTooltipRow[]
): ScheduleTooltipContent {
  const { pending_reason, requested, inherited } = schedule;
  const hint = scheduleStartHint(schedule);
  if (pending_reason === "awaiting_reconcile")
    return { status: hint, rows: running };

  const saved = isScheduleOverride(requested)
    ? scheduleRow(
        "target",
        i18n.t("connectors.schedule.tooltip.saved_by", {
          person,
          time: scheduleTooltipTimePhrase(requested.updated_at),
        }),
        requested.crons
      )
    : null;
  const reason = schedulePendingSentence(pending_reason);
  const sentences = reason ? [reason, hint] : [hint];

  if (pending_reason === "no_cronworkflow") {
    sentences.push(i18n.t("connectors.schedule.no_job_until_then"));
    return { status: sentences.join(" "), rows: saved ? [saved] : [] };
  }

  const target =
    saved ?? (inherited ? deploymentRow("target", inherited) : null);
  if (!running.length)
    sentences.push(i18n.t("connectors.schedule.no_job_until_then"));
  return {
    status: sentences.join(" "),
    rows: target ? [target, ...running] : running,
  };
}

export function scheduleTooltip(
  schedule: ConnectorSchedule | ScheduleRequestState | undefined,
  person = i18n.t("connectors.schedule.another_admin")
): ScheduleTooltipContent {
  const notLoaded = i18n.t("connectors.schedule.not_loaded");
  if (!schedule) return { status: notLoaded, rows: [] };
  if (schedule.read_error) return { status: schedule.read_error, rows: [] };

  if (!("status" in schedule)) {
    const observation = schedule.last_observation;
    if (!observation) return { status: notLoaded, rows: [] };

    const { label } = scheduleStatusView(observation.status);
    return {
      status: i18n.t("connectors.schedule.details_loading", { label }),
      rows: [],
    };
  }

  const { live, inherited, requested } = schedule;
  const running = live
    ? [
        scheduleRow(
          "running",
          i18n.t("connectors.schedule.tooltip.as_of", {
            time: scheduleObservationTime(live.observed_at),
          }),
          live.crons,
          live.timezone ?? i18n.t("connectors.controller_time")
        ),
      ]
    : [];
  switch (schedule.status) {
    case "paused":
      return { status: i18n.t("connectors.schedule.paused_detail"), rows: [] };
    case "inherited":
      return {
        status: inherited
          ? inheritedScheduleSentence(inherited.origin)
          : deploymentScheduleAvailability(schedule.next_reconcile_at),
        rows: running,
      };
    case "pending":
      return pendingTooltip(schedule, person, running);
    case "applied": {
      const saved = isScheduleOverride(requested);
      const deployment =
        saved && inherited ? [deploymentRow("deployment", inherited)] : [];
      const author = saved
        ? i18n.t("connectors.schedule.request_author", {
            person,
            time: scheduleTimePhrase(requested.updated_at),
          })
        : undefined;
      const status = live
        ? author
        : [author, i18n.t("connectors.schedule.live_unrecorded")]
            .filter(Boolean)
            .join(" ");
      return { status, rows: [...running, ...deployment] };
    }
    case null:
      return {
        status: i18n.t("connectors.schedule.live_unreadable"),
        rows: [],
      };
  }
}
