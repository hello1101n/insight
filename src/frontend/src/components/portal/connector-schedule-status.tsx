import { useTranslation } from "react-i18next";

import type { ConnectorSchedule } from "@/api/connector-health-client";
import { scheduleClock } from "@/lib/portal/connector-schedule-time";
import {
  conciseScheduleWords,
  scheduleIsOverdue,
} from "@/lib/portal/connector-schedule-display";

export function ConnectorScheduleStatus({
  schedule,
  reconcileIntervalSecs,
}: {
  schedule: ConnectorSchedule;
  reconcileIntervalSecs?: number | null;
}) {
  const { t } = useTranslation();
  if (schedule.read_error)
    return <p className="text-sm text-warning">{schedule.read_error}</p>;
  if (schedule.status !== "pending") return null;
  const overdue = scheduleIsOverdue(schedule, reconcileIntervalSecs);
  const hint = schedule.next_reconcile_at
    ? t("connectors.schedule.reconcile_expected", {
        time: scheduleClock(schedule.next_reconcile_at),
      })
    : t("connectors.schedule.next_pass");
  const live = schedule.live;
  const liveWords = live
    ? live.timezone === "UTC"
      ? t("connectors.schedule.with_utc", {
          words: conciseScheduleWords(live.crons).toLowerCase(),
        })
      : t("connectors.schedule.with_timezone", {
          crons: live.crons.join("; "),
          timezone: live.timezone ?? t("connectors.controller_time"),
        })
    : "";
  const running = live
    ? t("connectors.schedule.until_then", {
        schedule: live.suspended
          ? t("connectors.schedule_suspended", { timezone: liveWords })
          : liveWords,
      })
    : t("connectors.schedule.no_job_until_then");
  return (
    <p
      data-slot="schedule-hint"
      className={`text-sm ${overdue ? "text-warning" : "text-muted-foreground"}`}
    >
      <span>{hint}</span>
      {t("connectors.schedule.hint_detail", { running })}
      {overdue ? t("connectors.schedule.overdue") : ""}
    </p>
  );
}
