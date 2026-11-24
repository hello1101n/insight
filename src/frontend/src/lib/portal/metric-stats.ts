import {
  entityObserved,
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { quantile } from "@/lib/insight/within-team-peer";

export function medianAcross(
  r: NormalizedMetricResult | undefined,
  ids: readonly string[],
): number | null {
  if (!r) return null;
  const vals = ids
    .map((id) => forEntity(r, id).value)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (!vals.length) return null;
  return quantile([...vals].sort((a, b) => a - b), 0.5);
}

export function perCapita(r: NormalizedMetricResult, ids: readonly string[]): number {
  let total = 0;
  let active = 0;
  for (const id of ids) {
    const v = forEntity(r, id).value;
    if (v != null && Number.isFinite(v) && v > 0) {
      total += v;
      active += 1;
    }
  }
  return active ? total / active : 0;
}

export type PerPersonReading =
  | { kind: "average"; value: number; active: number; total: number }
  | { kind: "median"; value: number; people: number };

export function perPersonReading(
  r: NormalizedMetricResult | undefined,
  ids: readonly string[],
): PerPersonReading | null {
  if (!r) return null;
  const values = entityValues(r, ids).map((e) => e.value);
  if (!values.length) return null;

  if (r.computation !== "sum") {
    const sorted = [...values].sort((a, b) => a - b);
    return { kind: "median", value: quantile(sorted, 0.5), people: values.length };
  }

  const active = values.filter((v) => v > 0);
  const activeTotal = active.reduce((a, b) => a + b, 0);
  return {
    kind: "average",
    value: active.length ? activeTotal / active.length : 0,
    active: active.length,
    total: values.reduce((a, b) => a + b, 0),
  };
}

export interface EntityValue {
  id: string;
  value: number;
}

export function entityValues(
  r: NormalizedMetricResult | undefined,
  ids: readonly string[],
): EntityValue[] {
  if (!r) return [];
  return ids.flatMap((id) => {
    const value = forEntity(r, id).value;
    return value != null && Number.isFinite(value) ? [{ id, value }] : [];
  });
}

interface DistRow {
  label: string;
  range: string;
  count: number;
  ids: string[];
}

export function distribution(
  entries: readonly EntityValue[],
  fmt: (n: number) => string,
): DistRow[] {
  if (entries.length < 4) return [];
  const max = Math.max(...entries.map((e) => e.value));
  if (max <= 0) return [];
  const step = chooseStep(max, 14);
  const nBins = Math.max(1, Math.ceil(max / step));
  const bins: string[][] = Array.from({ length: nBins }, () => []);
  for (const { id, value } of entries) {
    bins[Math.min(nBins - 1, Math.max(0, Math.floor(value / step)))]!.push(id);
  }
  if (bins.filter((ids) => ids.length > 0).length < 2) return [];
  return bins.map((ids, i) => ({
    label: fmt(i * step),
    range: `${fmt(i * step)}–${fmt((i + 1) * step)}`,
    count: ids.length,
    ids,
  }));
}

export interface ChartClick {
  activeIndex?: number | string | null;
  activeTooltipIndex?: number | string | null;
  isTooltipActive?: boolean;
}

// WORKAROUND: recharts reports an index anywhere over the chart, `null` once the pointer
// leaves and the nearest category in the axis gutter; only `isTooltipActive` means a band is under it.
export function bandAtClick<Row>(
  rows: readonly Row[],
  click: ChartClick,
): Row | null {
  if (!click.isTooltipActive) return null;
  const index = click.activeIndex ?? click.activeTooltipIndex;
  if (index == null) return null;
  const at = Number(index);
  return Number.isInteger(at) ? (rows[at] ?? null) : null;
}

export function chooseStep(max: number, maxBins: number): number {
  const mults = [1, 2, 5];
  for (let pow = 0; pow < 12; pow++) {
    for (const m of mults) {
      const step = m * Math.pow(10, pow);
      if (Math.ceil(max / step) <= maxBins) return step;
    }
  }
  return max;
}

export function topDecile(
  entries: readonly EntityValue[],
): { share: number; ids: string[] } | null {
  if (entries.length < 4) return null;
  const sorted = [...entries].sort(
    (a, b) => b.value - a.value || a.id.localeCompare(b.id),
  );
  const total = sorted.reduce((sum, e) => sum + e.value, 0);
  if (total <= 0) return null;
  const top = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.1)));
  return {
    share: top.reduce((sum, e) => sum + e.value, 0) / total,
    ids: top.map((e) => e.id),
  };
}

export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1000) return `${trim(n / 1000)}k`;
  return trim(n);
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function familyObserved(
  byKey: Map<string, NormalizedMetricResult>,
  metricKeys: readonly string[],
  ids: readonly string[],
): boolean {
  for (const key of metricKeys) {
    const r = byKey.get(key);
    if (!r) continue;
    for (const id of ids) {
      if (entityObserved(r, id)) return true;
    }
  }
  return false;
}

export function groupCoverage(
  byKey: Map<string, NormalizedMetricResult>,
  groupKeys: readonly string[],
  ids: readonly string[],
): number | null {
  if (!ids.length) return null;
  let covered = 0;
  for (const id of ids) {
    const has = groupKeys.some((k) => {
      const r = byKey.get(k);
      return r != null && entityObserved(r, id);
    });
    if (has) covered += 1;
  }
  return covered / ids.length;
}
