import type { MetricDefinition } from "@/api/metric-definitions-client";
import { finiteValue, type NormalizedMetricResult } from "@/lib/metrics/collection";

export const LINES_KEY = "git.default_branch_lines";

export interface CombinedColumn {
  key: string;
  label: string;
  description: string;
  unit: string;
  scale: number;
  digits: number;
  parts: readonly { metricKey: string; sign: string }[];
}

const COMBINED_COLUMNS: readonly CombinedColumn[] = [
  {
    key: LINES_KEY,
    label: "Lines",
    description: "Lines added and removed that reached the default branch",
    unit: "KLOC",
    scale: 1000,
    digits: 1,
    parts: [
      { metricKey: "git.default_branch_lines_added", sign: "+" },
      { metricKey: "git.default_branch_lines_removed", sign: "−" },
    ],
  },
];

export function combinedColumn(key: string): CombinedColumn | undefined {
  return COMBINED_COLUMNS.find((column) => column.key === key);
}

export function withCombinedColumns(catalog: readonly MetricDefinition[]): MetricDefinition[] {
  return COMBINED_COLUMNS.reduce<MetricDefinition[]>(
    (list, column) => {
      const keys = new Set(list.map((metric) => metric.metric_key));
      if (!column.parts.every((part) => keys.has(part.metricKey))) return list;

      const at = list.findIndex((metric) => metric.metric_key === column.parts[0]?.metricKey);
      const combined: MetricDefinition = {
        ...list[at]!,
        metric_key: column.key,
        label: column.label,
        short_label: null,
        description: column.description,
        explanation: null,
        unit: column.unit,
        format: "decimal",
        direction: "neutral",
        dimensions: [],
      };
      return [...list.slice(0, at), combined, ...list.slice(at)];
    },
    [...catalog],
  );
}

export function requestedMetricKeys(keys: readonly string[]): string[] {
  const expanded = keys.flatMap(
    (key) => combinedColumn(key)?.parts.map((part) => part.metricKey) ?? [key],
  );
  return [...new Set(expanded)];
}

export function withCombinedResults(
  byKey: ReadonlyMap<string, NormalizedMetricResult>,
): Map<string, NormalizedMetricResult> {
  const merged = new Map(byKey);

  for (const column of COMBINED_COLUMNS) {
    const results = column.parts.flatMap((part) => {
      const result = byKey.get(part.metricKey);
      return result ? [result] : [];
    });
    const [first] = results;
    if (!first || results.length !== column.parts.length) continue;

    const ids = new Set(
      results.flatMap((result) => result.period?.values.map((v) => v.entity_id) ?? []),
    );
    const values = [...ids].map((entity_id) => {
      const found = results.map((result) => finiteValue(result, entity_id));
      const value = found.some((v) => v == null)
        ? null
        : found.reduce<number>((sum, v) => sum + (v ?? 0), 0) / column.scale;
      return { entity_id, value };
    });

    merged.set(column.key, {
      ...first,
      metric_key: column.key,
      label: column.label,
      short_label: undefined,
      unit: column.unit,
      format: "decimal",
      direction: "neutral",
      drilldown: undefined,
      selection: undefined,
      period: { view: "period", values },
    });
  }

  return merged;
}

export interface CombinedPart {
  text: string;
  value: number | null;
  result: NormalizedMetricResult | undefined;
}

export function combinedParts(
  column: CombinedColumn,
  byKey: ReadonlyMap<string, NormalizedMetricResult>,
  entityId: string,
): CombinedPart[] | null {
  const found = column.parts.map((part) => {
    const result = byKey.get(part.metricKey);
    return { part, result, value: result ? finiteValue(result, entityId) : null };
  });
  if (found.every(({ value }) => value == null)) return null;

  return found.map(({ part, result, value }) => ({
    text: value == null ? "—" : `${part.sign}${(value / column.scale).toFixed(column.digits)}`,
    value,
    result,
  }));
}

export function combinedFigure(
  column: CombinedColumn,
  byKey: ReadonlyMap<string, NormalizedMetricResult>,
  entityId: string,
): string | null {
  const parts = combinedParts(column, byKey, entityId);
  return parts ? parts.map((part) => part.text).join(" / ") : null;
}
