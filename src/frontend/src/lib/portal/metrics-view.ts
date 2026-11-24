import type { MetricDefinition } from "@/api/metric-definitions-client";
import type {
  MetricDimensionFilter,
  MetricDirection,
  MetricFormat,
} from "@/api/metric-results-client";
import { metricDisplayUnit } from "@/lib/format";
import {
  personDisplayName,
  type PersonNaming,
} from "@/lib/identities/person-display";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { normalizePersonId } from "@/lib/metrics/entity";
import { byFamily, familyName, familyOf } from "@/lib/reports/families";
import { runtimeConfig } from "@/lib/runtime-config";
import type { IdentityPerson } from "@/types/insight";

export interface MetricsRow {
  entityId: string;
  displayName: string;
  depth: number;
  hasReports: boolean;
  expanded: boolean;
}

export interface MetricGroup {
  family: string;
  name: string;
  keys: string[];
}

export type SortDirection = "ascending" | "descending";

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

export const DEFAULT_METRIC_KEYS: readonly string[] = [
  LINES_KEY,
  "git.pr_size",
  "git.default_branch_prs_merged",
  "git.default_branch_merge_rate",
  "git.pr_cycle_time_h",
  "git.reviews_performed",
  "git.pr_comments",
  "ai.active_days",
  "tasks.closed",
];

const PICK_STORAGE_KEY = "insight.metricsView.metrics";

export function readStoredMetricsPick(): string | null {
  try {
    return window.localStorage.getItem(PICK_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeMetricsPick(value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(PICK_STORAGE_KEY);
    else window.localStorage.setItem(PICK_STORAGE_KEY, value);
  } catch {
    return;
  }
}

export const METRIC_FILTERS: Readonly<Record<string, readonly MetricDimensionFilter[]>> = {
  "git.pr_comments": [{ dimension: "comment_target", values: ["others"] }],
};

function standMetricKeys(): readonly string[] {
  return runtimeConfig().metricsView?.defaultMetrics ?? [];
}

export function defaultMetricOrder(
  standKeys: readonly string[] = standMetricKeys(),
): readonly string[] {
  return standKeys.length > 0 ? standKeys : DEFAULT_METRIC_KEYS;
}

export function defaultMetricKeys(
  catalogKeys: readonly string[],
  standKeys: readonly string[] = standMetricKeys(),
): string[] {
  const defaults = new Set(defaultMetricOrder(standKeys));
  return catalogKeys.filter((key) => defaults.has(key));
}

export function orderMetricKeys(
  keys: readonly string[],
  order: readonly string[],
): string[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  const first = keys
    .filter((key) => rank.has(key))
    .sort((a, b) => rank.get(a)! - rank.get(b)!);
  return [...first, ...keys.filter((key) => !rank.has(key))];
}

function servesData(metric: MetricDefinition): boolean {
  if (metric.schema_status === "error") return false;
  return metric.origin === "custom" || metric.last_observed_date != null;
}

export function metricsViewCatalog(
  definitions: readonly MetricDefinition[],
  isOffered: (metric: MetricDefinition) => boolean,
): MetricDefinition[] {
  const offered = definitions.filter(
    (metric) =>
      metric.entity_type === "person" &&
      metric.is_enabled &&
      servesData(metric) &&
      isOffered(metric),
  );

  return byFamily(offered).flatMap((family) => family.metrics);
}

const PAGE_LABELS: Readonly<Record<string, string>> = {
  "ai.daily_approximate_extra_usage_cost": "AI extra cost",
};

export function withPageLabels<T extends { metric_key: string; label: string }>(
  items: readonly T[],
): T[] {
  return items.map((item) => {
    const label = PAGE_LABELS[item.metric_key];
    return label ? { ...item, label, short_label: null } : item;
  });
}

export function withPageResultLabels(
  byKey: ReadonlyMap<string, NormalizedMetricResult>,
): Map<string, NormalizedMetricResult> {
  return new Map(
    [...byKey].map(([key, result]) => {
      const label = PAGE_LABELS[key];
      return [key, label ? { ...result, label, short_label: undefined } : result];
    }),
  );
}

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
      const value = found.every((v) => v == null)
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
    text: `${part.sign}${((value ?? 0) / column.scale).toFixed(column.digits)}`,
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

export function chunkKeys(keys: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += size) {
    chunks.push(keys.slice(i, i + size));
  }
  return chunks;
}

export function finiteValue(
  result: NormalizedMetricResult,
  entityId: string,
): number | null {
  const { value } = forEntity(result, entityId);
  return value != null && Number.isFinite(value) ? value : null;
}

export function keysWithData(
  keys: readonly string[],
  byKey: ReadonlyMap<string, NormalizedMetricResult>,
  entityIds: readonly string[],
): string[] {
  return keys.filter((key) => {
    const result = byKey.get(key);
    return result != null && entityIds.some((id) => finiteValue(result, id) != null);
  });
}

function byName(a: { displayName: string }, b: { displayName: string }): number {
  return a.displayName.localeCompare(b.displayName);
}

function treeRows(
  node: IdentityPerson,
  depth: number,
  expanded: ReadonlySet<string>,
): MetricsRow[] {
  const entityId = normalizePersonId(node.person_id);
  const hasReports = node.subordinates.length > 0;
  const open = hasReports && expanded.has(entityId);
  const row = {
    entityId,
    displayName: personDisplayName(node),
    depth,
    hasReports,
    expanded: open,
  };
  if (!open) return [row];

  const reports = [...node.subordinates].sort((a, b) =>
    personDisplayName(a).localeCompare(personDisplayName(b)),
  );

  return [row, ...reports.flatMap((report) => treeRows(report, depth + 1, expanded))];
}

export function metricsRows(
  root: IdentityPerson | null,
  people: ReadonlyArray<PersonNaming & { person_id: string }>,
  expanded: ReadonlySet<string>,
): MetricsRow[] {
  if (root) return treeRows(root, 0, expanded);

  return people
    .map((person) => ({
      entityId: normalizePersonId(person.person_id),
      displayName: personDisplayName(person),
      depth: 0,
      hasReports: false,
      expanded: false,
    }))
    .sort(byName);
}

export function sortRows(
  rows: readonly MetricsRow[],
  metricKey: string,
  direction: SortDirection,
  byKey: ReadonlyMap<string, NormalizedMetricResult>,
): MetricsRow[] {
  const result = byKey.get(metricKey);
  const valueOf = (row: MetricsRow) => (result ? finiteValue(result, row.entityId) : null);
  const sign = direction === "ascending" ? 1 : -1;

  return rows
    .map((row) => ({ ...row, depth: 0 }))
    .sort((a, b) => {
      const left = valueOf(a);
      const right = valueOf(b);
      if (left == null) return right == null ? byName(a, b) : 1;
      if (right == null) return -1;
      return (left - right) * sign || byName(a, b);
    });
}

export function metricGroups(keys: readonly string[]): MetricGroup[] {
  const groups: MetricGroup[] = [];
  for (const key of keys) {
    const family = familyOf(key);
    const last = groups.at(-1);
    if (last?.family === family) last.keys.push(key);
    else groups.push({ family, name: familyName(family), keys: [key] });
  }
  return groups;
}

export interface CompareTeam {
  id: string;
  name: string;
  memberIds: string[];
}

function subtreeIds(node: IdentityPerson): string[] {
  return [normalizePersonId(node.person_id), ...node.subordinates.flatMap(subtreeIds)];
}

export function compareTeams(root: IdentityPerson | null): CompareTeam[] {
  if (!root || root.subordinates.length === 0) return [];

  return [
    {
      id: normalizePersonId(root.person_id),
      name: personDisplayName(root),
      memberIds: subtreeIds(root),
    },
    ...root.subordinates.flatMap(compareTeams),
  ];
}

export interface CompareCell {
  best: boolean;
  gap: number | null;
}

export function compareGaps(
  values: ReadonlyArray<number | null>,
  direction: MetricDirection,
): CompareCell[] {
  const present = values.filter((value): value is number => value != null);
  const best = direction === "lower_is_better" ? Math.min(...present) : Math.max(...present);
  const ranked =
    direction !== "neutral" && present.length >= 2 && present.some((value) => value !== best);

  return values.map((value) => {
    if (!ranked || value == null) return { best: false, gap: null };
    if (value === best) return { best: true, gap: null };
    return {
      best: false,
      gap: best === 0 ? null : Math.round(((value - best) / Math.abs(best)) * 100),
    };
  });
}

export function formatGap(gap: number | null): string {
  if (gap == null) return "";
  if (gap === 0) return "≈";
  return `${gap > 0 ? "+" : "−"}${Math.abs(gap)}%`;
}

export function headerUnit(
  label: string,
  format: MetricFormat,
  unit: string | null,
): string | null {
  const shown = metricDisplayUnit(format, unit);
  if (!shown) return null;
  return label.toLocaleLowerCase().includes(shown.toLocaleLowerCase()) ? null : shown;
}

export function rolesById(root: IdentityPerson | null): Map<string, string> {
  const roles = new Map<string, string>();
  const walk = (node: IdentityPerson) => {
    const role = node.job_title?.trim();
    if (role) roles.set(normalizePersonId(node.person_id), role);
    node.subordinates.forEach(walk);
  };
  if (root) walk(root);
  return roles;
}
