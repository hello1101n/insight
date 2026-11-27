import type { MetricDefinition } from "@/api/metric-definitions-client";
import type {
  PersonalCalculation,
  PersonalMetric,
  PersonalSharedBy,
  PersonalValues,
} from "@/api/personal-metrics-client";
import type { MetricFormat } from "@/api/metric-results-client";
import type { DateRange } from "@/api/period-to-date-range";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";

export const PERSONAL_PREFIX = "personal.";

export function personalKey(id: string): string {
  return `${PERSONAL_PREFIX}${id}`;
}

export function isPersonalKey(key: string): boolean {
  return key.startsWith(PERSONAL_PREFIX);
}

export const CALCULATION_LABEL: Record<PersonalCalculation, string> = {
  sum: "Total",
  count: "Count",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  ratio: "Ratio",
  percent: "Percent",
};

export type PersonalMetricDefinition = MetricDefinition & {
  calculation: PersonalCalculation;
  shared_by: PersonalSharedBy | null;
};

const FORMATS: Record<PersonalMetric["format"], MetricFormat> = {
  number: "decimal",
  duration: "decimal",
  percent: "percent",
  currency: "currency",
};

export function exclusiveEnd(range: DateRange): DateRange {
  const [y, m, d] = range.to.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d! + 1));
  return { from: range.from, to: next.toISOString().slice(0, 10) };
}

export function personalDefinition(
  metric: PersonalMetric,
): PersonalMetricDefinition {
  return {
    metric_key: personalKey(metric.id),
    entity_type: "person",
    label: metric.label,
    short_label: null,
    description: metric.description,
    explanation: null,
    unit: metric.unit,
    format: FORMATS[metric.format],
    direction: metric.direction,
    dimensions: [],
    is_enabled: true,
    origin: "custom",
    schema_status: "ok",
    schema_error_code: null,
    first_observed_date: null,
    last_observed_date: null,
    calculation: metric.calculation,
    shared_by: metric.shared_by,
  };
}

export function failedPersonalKeys(values: PersonalValues, keys: string[]): string[] {
  const failed = new Set(values.errors.map((error) => error.metric));
  return keys.filter((key) => failed.has(key.slice(PERSONAL_PREFIX.length)));
}

export function personalResults(
  values: PersonalValues,
  keys: string[],
): Map<string, NormalizedMetricResult> {
  const out = new Map<string, NormalizedMetricResult>();
  for (const key of keys) {
    const id = key.slice(PERSONAL_PREFIX.length);
    out.set(key, {
      metric_key: key,
      label: id,
      unit: null,
      computation: "sum",
      format: "decimal",
      direction: "neutral",
      period: {
        view: "period",
        values: values.values
          .filter((row) => row.metric === id)
          .map((row) => ({
            entity_id: row.person_id.toLowerCase(),
            value: row.value,
          })),
      },
    });
  }
  return out;
}

export function medianRow(values: readonly unknown[]): number | null {
  const numbered = values
    .map((value, row) => ({ value, row }))
    .filter(
      (entry): entry is { value: number; row: number } =>
        typeof entry.value === "number" && Number.isFinite(entry.value),
    )
    .sort((a, b) => a.value - b.value || a.row - b.row);
  if (numbered.length < 2) return null;

  return numbered[Math.floor((numbered.length - 1) / 2)]!.row;
}
