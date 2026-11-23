import { useTranslation } from "react-i18next";
import { Alert, Button } from "@gears-frontx/ui-kit";

import type { ConnectorSchedule } from "@/api/connector-health-client";
import {
  scheduleIsOverdue,
  schedulePendingSentence,
  scheduleStartHint,
  scheduleUntilThen,
} from "@/lib/portal/connector-schedule-display";

export function ConnectorScheduleStatus({
  schedule,
  reconcileIntervalSecs,
  onSaveAgain,
  saving,
}: {
  schedule: ConnectorSchedule;
  reconcileIntervalSecs?: number | null;
  onSaveAgain: () => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  if (schedule.read_error)
    return <p className="text-sm text-warning">{schedule.read_error}</p>;
  if (schedule.status !== "pending") return null;
  const reason = schedulePendingSentence(schedule.pending_reason);
  const interval = schedule.reconcile_interval_secs ?? reconcileIntervalSecs;
  return (
    <>
      <p data-slot="schedule-hint" className="text-sm text-muted-foreground">
        {reason && <>{reason} </>}
        <span>{scheduleStartHint(schedule)}</span>{" "}
        {scheduleUntilThen(schedule.live)}
      </p>
      {interval != null && scheduleIsOverdue(schedule, interval) && (
        <Alert role="alert">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-warning">
              {t("connectors.schedule.overdue", {
                count: Math.ceil(interval / 30),
              })}
            </span>
            {schedule.pending_reason === "different_schedule" && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={saving}
                disabled={saving}
                onClick={onSaveAgain}
              >
                {t("connectors.schedule.overdue_action")}
              </Button>
            )}
          </div>
        </Alert>
      )}
    </>
  );
}
