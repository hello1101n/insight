import type { MetricEvidenceRow } from "@/api/metric-drilldown-client";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";

export type MetricGrain = "event" | "derived_population" | "source_summary";

const GRAIN_ORDER: MetricGrain[] = [
  "event",
  "derived_population",
  "source_summary",
];

export function finestGrain(
  metric: NormalizedMetricResult | undefined
): MetricGrain | null {
  const declared = metric?.drilldown?.granularity ?? [];
  return GRAIN_ORDER.find((grain) => declared.includes(grain)) ?? null;
}

export interface DayReading {
  date: string;
  value: number;
  numerator: number | null;
  denominator: number | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ActivityEvent {
  ref: string | null;
  title: string | null;
  context: string | null;
  date: string;
  value: number | null;
  links: Readonly<Record<string, string>>;
  values: Readonly<Record<string, unknown>>;
}

function firstLine(title: string): string {
  return title.split("\n", 1)[0]?.trim() ?? "";
}

export function activityEvents(rows: MetricEvidenceRow[]): ActivityEvent[] {
  return rows
    .flatMap((row) => {
      const date = row.values.date;
      if (typeof date !== "string") return [];
      const title = row.values.title;
      const context = row.values.repository ?? row.values.space;
      const ref = row.values.ref;
      return [
        {
          ref: typeof ref === "string" ? ref : null,
          title: typeof title === "string" ? firstLine(title) || null : null,
          context: typeof context === "string" ? context : null,
          date,
          value: num(row.values.value),
          links: row.links ?? {},
          values: row.values,
        },
      ];
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}
