import i18n from "@/i18n";

import { nextScheduledRuns } from "@/lib/portal/connector-schedule";

export function scheduleRuns(
  crons: string[],
  timezone: string,
  now: Date
): Date[] {
  try {
    const runs = crons.flatMap((cron) =>
      nextScheduledRuns(cron, timezone, now, 3, Infinity)
    );
    return [...new Set(runs.map(Number))]
      .sort((a, b) => a - b)
      .slice(0, 3)
      .map((time) => new Date(time));
  } catch {
    return [];
  }
}

export function scheduleTime(value: string | Date): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "—";
  return i18n.t("connectors.schedule.with_utc", {
    words: time.toISOString().replace("T", " ").slice(0, 19),
  });
}

export function relativeScheduleTime(
  value: string | Date,
  now = new Date()
): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "—";
  const delay = time.getTime() - now.getTime();
  const elapsed = Math.abs(delay);
  if (elapsed < 60_000) return i18n.t("connectors.just_now");
  const [size, unit] =
    elapsed < 3_600_000
      ? ([60_000, "minutes"] as const)
      : elapsed < 86_400_000
        ? ([3_600_000, "hours"] as const)
        : ([86_400_000, "days"] as const);
  const count = Math.round(elapsed / size);
  return delay > 0
    ? i18n.t(`connectors.schedule.relative_${unit}`, { count })
    : i18n.t(`connectors.${unit}_ago`, { count });
}

export function scheduleClock(value: string | Date | null | undefined): string {
  if (value == null) return "—";
  const time = new Date(value);
  return Number.isFinite(time.getTime())
    ? time.toISOString().slice(11, 16)
    : "—";
}

export function shortScheduleTime(value: Date, now = new Date()): string {
  const time = scheduleClock(value);
  if (time === "—") return time;
  if (value.toISOString().slice(0, 10) === now.toISOString().slice(0, 10))
    return time;
  const weekday = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    timeZone: "UTC",
  }).format(value);
  return `${weekday} ${time}`;
}
