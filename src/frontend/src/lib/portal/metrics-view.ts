import type { MetricDefinition } from "@/api/metric-definitions-client";
import type { MetricDirection } from "@/api/metric-results-client";
import {
  formatClockDuration,
  formatMetricValue,
  isClockDuration,
} from "@/lib/format";
import {
  personDisplayName,
  type PersonNaming,
} from "@/lib/identities/person-display";
import {
  finiteValue,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { normalizePersonId } from "@/lib/metrics/entity";
import { byFamily, familyName, familyOf } from "@/lib/reports/families";
import { combinedColumn, LINES_KEY } from "@/lib/portal/metrics-view-combined";
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

export const DEFAULT_METRIC_KEYS: readonly string[] = [
  LINES_KEY,
  "git.pr_size",
  "git.default_branch_prs_merged",
  "git.default_branch_merge_rate",
  "git.pr_cycle_time_h",
  "git.reviews_performed",
  "git.pr_comments_on_others",
  "ai.active_days",
  "tasks.closed",
];

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
  const byFamily = new Map<string, string[]>();
  for (const key of [...first, ...keys.filter((key) => !rank.has(key))]) {
    const family = familyOf(key);
    byFamily.set(family, [...(byFamily.get(family) ?? []), key]);
  }
  return [...byFamily.values()].flat();
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

export function chunkKeys(keys: readonly string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += size) {
    chunks.push(keys.slice(i, i + size));
  }
  return chunks;
}

export function keysWithData(
  keys: readonly string[],
  byKey: ReadonlyMap<string, NormalizedMetricResult>,
  entityIds: readonly string[],
): string[] {
  return keys.filter((key) => {
    const sources = combinedColumn(key)?.parts.map((part) => part.metricKey) ?? [key];
    return sources.some((source) => {
      const result = byKey.get(source);
      return result != null && entityIds.some((id) => finiteValue(result, id) != null);
    });
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

export function formatViewValue(
  value: number,
  result: Pick<NormalizedMetricResult, "format" | "unit">,
): string {
  return isClockDuration(result.format, result.unit)
    ? formatClockDuration(value)
    : formatMetricValue(value, result.format, result.unit);
}

export interface PersonTeam {
  id: string;
  name: string;
}

export function teamsById(root: IdentityPerson | null): Map<string, PersonTeam> {
  const teams = new Map<string, PersonTeam>();
  const walk = (node: IdentityPerson) => {
    const team = { id: normalizePersonId(node.person_id), name: personDisplayName(node) };
    for (const report of node.subordinates) {
      teams.set(normalizePersonId(report.person_id), team);
      walk(report);
    }
  };
  if (root) walk(root);
  return teams;
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

const COMPUTATION_LABEL: Record<NormalizedMetricResult["computation"], string> = {
  sum: "Total",
  ratio: "Ratio",
  median: "Median",
  percentile: "Percentile",
  stddev: "Std dev",
  distinct_count: "Total",
};

export function computationWord(
  result: Pick<NormalizedMetricResult, "computation">,
): string {
  return COMPUTATION_LABEL[result.computation];
}

export function columnFormula(
  result: Pick<NormalizedMetricResult, "computation" | "format" | "unit">,
): string {
  const unit = isClockDuration(result.format, result.unit)
    ? "h min"
    : result.format === "percent"
      ? "%"
      : result.format === "currency"
        ? "USD"
        : result.unit;

  const word = COMPUTATION_LABEL[result.computation];
  if (unit != null) return `${word} · ${unit}`;

  return result.computation === "sum" || result.computation === "distinct_count"
    ? `${word} · count`
    : word;
}

const DIRECTION_LABEL: Record<MetricDirection, string> = {
  higher_is_better: "Higher is better",
  lower_is_better: "Lower is better",
  neutral: "Neutral",
};

const DIRECTION_PREFIXED: ReadonlySet<NormalizedMetricResult["computation"]> = new Set([
  "median",
  "percentile",
  "stddev",
]);

export function directionNote(
  result: Pick<NormalizedMetricResult, "computation" | "direction">,
): string {
  const direction = DIRECTION_LABEL[result.direction];
  return DIRECTION_PREFIXED.has(result.computation)
    ? `${COMPUTATION_LABEL[result.computation]} · ${direction}`
    : direction;
}
