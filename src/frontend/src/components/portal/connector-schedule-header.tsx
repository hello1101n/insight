import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import type { ConnectorSchedule } from "@/api/connector-health-client";
import { ConnectorScheduleTooltip } from "@/components/portal/connector-schedule-tooltip";
import { Badge } from "@gears-frontx/ui-kit";
import { scheduleStatusView } from "@/lib/portal/connector-schedule-status";
import { scheduleTooltip } from "@/lib/portal/connector-schedule-tooltip";
import { useConnectorScheduleAuthor } from "@/queries/connector-schedule-author";

export function ConnectorScheduleHeader({
  schedule,
  loading = false,
  children,
}: {
  schedule: ConnectorSchedule | undefined;
  loading?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const person = useConnectorScheduleAuthor(schedule?.requested?.updated_by);
  const { label, Icon, variant, iconClass } = scheduleStatusView(
    schedule?.status,
    schedule?.pending_reason
  );
  return (
    <header className="flex min-h-8 min-w-0 flex-wrap items-center gap-2">
      <h3 className="shrink-0 text-sm font-medium">
        {t("connectors.schedule.heading")}
      </h3>
      <div
        data-slot="schedule-header-status"
        className="flex min-w-0 items-center"
      >
        {loading ? (
          <span className="text-xs text-muted-foreground">
            {t("common.states.loading")}
          </span>
        ) : (
          <ConnectorScheduleTooltip content={scheduleTooltip(schedule, person)}>
            <Badge
              variant={variant}
              title={label}
              className="max-w-full min-w-0"
            >
              <Icon aria-hidden="true" className={iconClass} />
              <span className="truncate">{label}</span>
            </Badge>
          </ConnectorScheduleTooltip>
        )}
      </div>
      {children}
    </header>
  );
}
