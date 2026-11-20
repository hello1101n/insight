import i18n from "@/i18n";

import { Check, Clock, Minus } from "lucide-react";
import type {
  SchedulePendingReason,
  ScheduleStatus,
} from "@/api/connector-health-client";

export function scheduleStatusView(
  status: ScheduleStatus | null | undefined,
  reason?: SchedulePendingReason | null
) {
  const label =
    status === "pending"
      ? reason === "no_cronworkflow"
        ? i18n.t("connectors.schedule.status.not_scheduled")
        : i18n.t("connectors.schedule.status.pending")
      : status === "applied"
        ? i18n.t("connectors.schedule.status.applied")
        : status === "inherited"
          ? i18n.t("connectors.schedule.status.default")
          : status === "paused"
            ? i18n.t("connectors.schedule.status.paused")
            : status === undefined
              ? i18n.t("connectors.schedule.status.not_loaded")
              : i18n.t("connectors.schedule.status.unavailable");
  const Icon =
    status === "applied" ? Check : status === "pending" ? Clock : Minus;
  const variant =
    status === "applied"
      ? "success"
      : status === "pending"
        ? "warning"
        : "secondary";
  const tone = {
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    secondary: "text-muted-foreground",
  }[variant];
  return { label, Icon, variant, tone, iconClass: "size-3 shrink-0" } as const;
}
