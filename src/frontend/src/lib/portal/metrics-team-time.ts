import { addDays, subDays } from "date-fns";

import { parseISOCalendarDate, toISODate, type DateRange } from "@/api/period-to-date-range";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import { finiteValue } from "@/lib/portal/metrics-view";

export const TEAM_TIME_WEEKS = [1, 2, 4] as const;

export type TeamTimeWeeks = (typeof TEAM_TIME_WEEKS)[number];

export const DEFAULT_TEAM_TIME_WEEKS: TeamTimeWeeks = 2;

export function asTeamTimeWeeks(value: unknown): TeamTimeWeeks | undefined {
  const weeks = typeof value === "string" ? Number(value) : value;
  return TEAM_TIME_WEEKS.find((option) => option === weeks);
}

export interface TeamTimePeriods {
  after: DateRange;
  before: DateRange;
}

function dayOf(iso: string): Date {
  const day = parseISOCalendarDate(iso);
  if (!day) throw new Error(`Not a calendar date: ${iso}`);
  return day;
}

export function teamTimePeriods(change: string, weeks: TeamTimeWeeks): TeamTimePeriods {
  const start = dayOf(change);
  const days = 7 * weeks;

  return {
    after: { from: change, to: toISODate(addDays(start, days - 1)) },
    before: { from: toISODate(subDays(start, days)), to: toISODate(subDays(start, 1)) },
  };
}

export function latestChangeDate(weeks: TeamTimeWeeks, today: Date): string {
  return toISODate(subDays(today, 7 * weeks));
}

export function resolveChangeDate(
  change: string | undefined,
  weeks: TeamTimeWeeks,
  today: Date,
): string {
  const latest = latestChangeDate(weeks, today);
  return change && change < latest ? change : latest;
}

const DAY_MONTH: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
const DAY_MONTH_YEAR: Intl.DateTimeFormatOptions = { ...DAY_MONTH, year: "numeric" };

export function formatChangeDay(iso: string, withYear = false): string {
  return dayOf(iso).toLocaleDateString("en-GB", withYear ? DAY_MONTH_YEAR : DAY_MONTH);
}

export function formatPeriodRange({ from, to }: DateRange): string {
  const start = dayOf(from);
  const end = dayOf(to);

  if (start.getFullYear() !== end.getFullYear()) {
    return `${formatChangeDay(from, true)} – ${formatChangeDay(to, true)}`;
  }
  if (start.getMonth() !== end.getMonth()) {
    return `${formatChangeDay(from)} – ${formatChangeDay(to)}`;
  }
  return `${start.getDate()}–${formatChangeDay(to)}`;
}

export function teamSum(
  result: NormalizedMetricResult,
  memberIds: readonly string[],
): number | null {
  if (result.computation !== "sum") return null;

  const values = memberIds.flatMap((id) => {
    const value = finiteValue(result, id);
    return value == null ? [] : [value];
  });
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}
