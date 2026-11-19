import cronstrue from "cronstrue";

import i18n from "@/i18n";

export const HOUR_CHOICES = [1, 2, 3, 4, 6, 8, 12] as const;
export type ScheduleChoice =
  | { kind: "hours"; hours: number; time: string }
  | { kind: "daily" | "weekdays"; time: string }
  | { kind: "custom"; crons: string[] };

const DAY_MINUTES = 1440;

function wrap(minutes: number): number {
  return ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
}

function clock(minutes: number): string {
  const wrapped = wrap(minutes);
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

export function choiceCrons(choice: ScheduleChoice): string[] {
  if (choice.kind === "custom") return [...choice.crons];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(choice.time)) return [];

  const [hour, minute] = choice.time.split(":").map(Number);
  if (choice.kind === "hours") {
    if (choice.hours === 1) return [`${minute} * * * *`];

    const starts = [];
    for (let step = 0; step < 24; step += choice.hours) {
      starts.push((hour + step) % 24);
    }
    starts.sort((a, b) => a - b);
    return [`${minute} ${starts.join(",")} * * *`];
  }

  const days = choice.kind === "daily" ? "*" : "1-5";
  return [`${minute} ${hour} * * ${days}`];
}

export function detectChoice(crons: string[]): ScheduleChoice {
  if (crons.length !== 1) return { kind: "custom", crons: [...crons] };

  for (const hours of HOUR_CHOICES) {
    for (let minute = 0; minute < hours * 60; minute++) {
      const choice = { kind: "hours", hours, time: clock(minute) } as const;
      if (choiceCrons(choice)[0] === crons[0]) return choice;
    }
  }
  for (const kind of ["daily", "weekdays"] as const) {
    for (let minute = 0; minute < DAY_MINUTES; minute++) {
      const choice = { kind, time: clock(minute) };
      if (choiceCrons(choice)[0] === crons[0]) return choice;
    }
  }
  return { kind: "custom", crons: [...crons] };
}

export function cronTranslation(cron: string, concise = false): string | null {
  try {
    const words = cronstrue.toString(cron, {
      use24HourTimeFormat: true,
      verbose: false,
    });
    return concise
      ? words.replace(/\.+$/, "")
      : i18n.t("connectors.schedule.with_utc", { words });
  } catch {
    return null;
  }
}

export function choiceSummary(
  choice: ScheduleChoice,
  concise = false
): string | null {
  const key = concise ? "concise" : "summary";
  switch (choice.kind) {
    case "hours": {
      if (choice.hours === 1)
        return i18n.t(`connectors.schedule.${key}.hourly`, {
          minute: choice.time.slice(3),
        });

      const [hours, minutes] = choice.time.split(":").map(Number);
      const starts = [];
      for (let step = 0; step < 24; step += choice.hours) {
        starts.push(clock(hours * 60 + minutes + step * 60));
      }
      starts.sort();
      return i18n.t(`connectors.schedule.${key}.hours`, {
        count: choice.hours,
        times: starts.join(", "),
      });
    }
    case "daily":
      return i18n.t(`connectors.schedule.${key}.daily`, { time: choice.time });
    case "weekdays":
      return i18n.t(`connectors.schedule.${key}.weekdays`, {
        time: choice.time,
      });
    case "custom":
      if (choice.crons.length === 1)
        return cronTranslation(choice.crons[0], concise);
      return concise
        ? null
        : i18n.t("connectors.schedule.summary.expressions", {
            count: choice.crons.length,
          });
  }
}

export function scheduleWords(crons: string[], concise = false): string | null {
  return choiceSummary(detectChoice(crons), concise);
}
