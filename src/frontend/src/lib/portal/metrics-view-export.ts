import type { DateRange } from "@/api/period-to-date-range";
import i18n from "@/i18n";
import type { Matrix, MatrixCell } from "@/lib/export/matrix";
import { isDurationUnit, roundMetricValue } from "@/lib/format";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import { teamSum, type TeamTimePeriods } from "@/lib/portal/metrics-team-time";
import { finiteValue } from "@/lib/portal/metrics-view";

export interface MetricsViewExport {
  people: ReadonlyArray<{ entityId: string; displayName: string }>;
  keys: readonly string[];
  byKey: ReadonlyMap<string, NormalizedMetricResult>;
  roles: ReadonlyMap<string, string>;
  range: DateRange;
}

function fileUnit({ format, unit }: NormalizedMetricResult): string | null {
  if (format === "percent") return "%";
  if (format === "currency") return "$";
  return unit;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

function namesUnit(label: string, unit: string): boolean {
  const haystack = label.toLowerCase();
  const needle = unit.toLowerCase();
  if (!needle) return false;

  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + needle.length])) return true;
  }
  return false;
}

function columnTitle(key: string, result: NormalizedMetricResult | undefined): string {
  const label = result?.label ?? key;
  const unit = result ? fileUnit(result) : null;
  return unit && !namesUnit(label, unit) ? `${label} (${unit})` : label;
}

function fileNumber(value: number, result: NormalizedMetricResult): number {
  return isDurationUnit(result.unit)
    ? Math.round(value * 100) / 100
    : roundMetricValue(value, result.format);
}

function fileValue(
  result: NormalizedMetricResult | undefined,
  entityId: string,
): number | null {
  if (!result) return null;

  const value = finiteValue(result, entityId);
  return value == null ? null : fileNumber(value, result);
}

export function metricsViewMatrix({
  people,
  keys,
  byKey,
  roles,
  range,
}: MetricsViewExport): Matrix {
  const withRoles = people.some((person) => roles.has(person.entityId));
  const period = `${range.from} – ${range.to}`;

  const columns = [
    i18n.t("common.table.person"),
    ...(withRoles ? [i18n.t("common.table.role")] : []),
    i18n.t("common.table.period"),
    ...keys.map((key) => columnTitle(key, byKey.get(key))),
  ];
  const rows = people.map((person): MatrixCell[] => [
    person.displayName,
    ...(withRoles ? [roles.get(person.entityId) ?? null] : []),
    period,
    ...keys.map((key) => fileValue(byKey.get(key), person.entityId)),
  ]);

  return { columns, rows };
}

export function metricsViewFilename(range: DateRange, extension: "csv" | "xlsx"): string {
  return `metrics-view_${range.from}_${range.to}.${extension}`;
}

export interface TeamTimeExport {
  keys: readonly string[];
  after: ReadonlyMap<string, NormalizedMetricResult>;
  before: ReadonlyMap<string, NormalizedMetricResult>;
  memberIds: readonly string[];
  periods: TeamTimePeriods;
}

function filePeriod(range: DateRange): string {
  return `${range.from} – ${range.to}`;
}

export function teamTimeMatrix({
  keys,
  after,
  before,
  memberIds,
  periods,
}: TeamTimeExport): Matrix {
  const columns = [
    i18n.t("metrics_view.metric"),
    i18n.t("metrics_view.after", { range: filePeriod(periods.after) }),
    i18n.t("metrics_view.before", { range: filePeriod(periods.before) }),
  ];
  const rows = keys.flatMap((key): MatrixCell[][] => {
    const result = after.get(key) ?? before.get(key);
    if (!result) return [];

    const total = (side: ReadonlyMap<string, NormalizedMetricResult>) => {
      const sideResult = side.get(key);
      const value = sideResult ? teamSum(sideResult, memberIds) : null;
      return value == null ? null : fileNumber(value, result);
    };
    return [[columnTitle(key, result), total(after), total(before)]];
  });

  return { columns, rows };
}

export function teamTimeFilename(periods: TeamTimePeriods, extension: "csv" | "xlsx"): string {
  return `metrics-view_team_${periods.before.from}_${periods.after.to}.${extension}`;
}
