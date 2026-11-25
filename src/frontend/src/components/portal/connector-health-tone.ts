import type { BadgeProps } from "@gears-frontx/ui-kit";

import type { ConnectorTone } from "@/lib/portal/connector-health";

export const TONE_BADGE: Record<ConnectorTone, BadgeProps["variant"]> = {
  failing: "danger",
  unknown: "warning",
  active: "info",
  ok: "success",
  idle: "secondary",
};

export const TONE_STYLE: Record<ConnectorTone, string> = {
  failing: "bg-destructive/15 text-destructive",
  unknown: "bg-warning/15 text-warning",
  active: "bg-primary/15 text-primary",
  ok: "bg-success/15 text-success",
  idle: "bg-muted text-muted-foreground",
};

export const TONE_BAR_STYLE: Record<ConnectorTone, string> = {
  failing: "bg-destructive",
  unknown: "bg-warning",
  active: "bg-primary",
  ok: "bg-success",
  idle: "bg-muted-foreground",
};

export function historySegmentStyle(status: string, tone: ConnectorTone) {
  return status === "cancelled"
    ? "bg-muted bg-[repeating-linear-gradient(135deg,transparent_0_3px,var(--muted-foreground)_3px_5px)]"
    : TONE_BAR_STYLE[tone];
}
