import type { DayReading } from "@/lib/insight/metric-grain";
import type { CollectionBoundary } from "@/queries/metric-definitions";

export type DayCoverage =
  "covered" | "before_available_data" | "not_yet_collected";

export interface StripDay {
  date: string;
  value: number | null;
  coverage: DayCoverage;
  provisional: boolean;
  height: number | null;
  numerator: number | null;
  denominator: number | null;
}

const DAY_MS = 86_400_000;

function calendar(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return [];
  const days: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

export function stripDays(
  readings: DayReading[],
  from: string,
  to: string,
  boundary?: CollectionBoundary
): StripDay[] {
  const byDate = new Map(readings.map((r) => [r.date, r]));
  const days = calendar(from, to);
  const peak = days.reduce(
    (max, date) => Math.max(max, byDate.get(date)?.value ?? 0),
    0
  );
  const collectedFrom = boundary?.collectedFrom ?? null;
  const collectedThrough = boundary?.collectedThrough ?? null;
  const settledThrough = boundary?.settledThrough ?? null;
  return days.map((date) => {
    const coverage: DayCoverage =
      collectedFrom != null && date < collectedFrom
        ? "before_available_data"
        : collectedThrough != null && date > collectedThrough
          ? "not_yet_collected"
          : "covered";
    const provisional =
      coverage === "covered" && settledThrough != null && date > settledThrough;
    const reading = byDate.get(date);
    if (!reading) {
      return {
        date,
        coverage,
        provisional,
        value: null,
        height: null,
        numerator: null,
        denominator: null,
      };
    }
    return {
      date,
      coverage,
      provisional,
      value: reading.value,
      height: peak > 0 ? reading.value / peak : 0,
      numerator: reading.numerator,
      denominator: reading.denominator,
    };
  });
}

export function isCovered(day: StripDay): boolean {
  return day.coverage === "covered";
}

export function silentDays(days: StripDay[]): number {
  return days.filter((d) => isCovered(d) && d.value == null).length;
}

export function beforeAvailableDataDays(days: StripDay[]): number {
  return days.filter((d) => d.coverage === "before_available_data").length;
}

export function notYetCollectedDays(days: StripDay[]): number {
  return days.filter((d) => d.coverage === "not_yet_collected").length;
}

export function provisionalDays(days: StripDay[]): number {
  return days.filter((d) => d.provisional).length;
}
