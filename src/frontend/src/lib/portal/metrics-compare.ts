import type { MetricDirection } from "@/api/metric-results-client";
import {
  formatClockDuration,
  formatMetricNumber,
  isClockDuration,
  roundMetricValue,
} from "@/lib/format";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import type { PersonTeam } from "@/lib/portal/metrics-view";

type ValueFormat = Pick<NormalizedMetricResult, "format" | "unit">;
type CompareFormat = Pick<NormalizedMetricResult, "direction" | "format" | "unit">;

export interface BestCell {
  best: boolean;
  delta: number | null;
}

export interface MedianCell {
  atMedian: boolean;
  best: boolean;
  delta: number | null;
  better: boolean | null;
}

export interface MedianComparison {
  median: number | null;
  present: number;
  cells: MedianCell[];
}

const PLAIN_BEST: BestCell = { best: false, delta: null };
const PLAIN_MEDIAN: MedianCell = { atMedian: false, best: false, delta: null, better: null };

function shownValue(value: number, result: ValueFormat): number {
  return isClockDuration(result.format, result.unit)
    ? Math.round(value * 60) / 60
    : roundMetricValue(value, result.format);
}

function shownValues(
  values: ReadonlyArray<number | null>,
  result: ValueFormat,
): Array<number | null> {
  return values.map((value) => (value == null ? null : shownValue(value, result)));
}

function presentOf(values: ReadonlyArray<number | null>): number[] {
  return values.filter((value): value is number => value != null);
}

function rankedBest(present: readonly number[], direction: MetricDirection): number | null {
  if (direction === "neutral" || present.length < 2) return null;

  const best = direction === "lower_is_better" ? Math.min(...present) : Math.max(...present);
  return present.some((value) => value !== best) ? best : null;
}

export function compareWithBest(
  values: ReadonlyArray<number | null>,
  result: CompareFormat,
): BestCell[] {
  const shown = shownValues(values, result);
  const best = rankedBest(presentOf(shown), result.direction);

  return shown.map((value) => {
    if (best == null || value == null) return PLAIN_BEST;
    if (value === best) return { best: true, delta: null };
    return { best: false, delta: value - best };
  });
}

function middleOf(sorted: readonly number[]): number {
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
}

export function compareWithMedian(
  values: ReadonlyArray<number | null>,
  result: CompareFormat,
): MedianComparison {
  const shown = shownValues(values, result);
  const present = presentOf(shown);
  const median =
    present.length === 0
      ? null
      : shownValue(middleOf([...present].sort((a, b) => a - b)), result);
  const best = rankedBest(present, result.direction);

  const cells = shown.map((value): MedianCell => {
    if (value == null || median == null || result.direction === "neutral") return PLAIN_MEDIAN;

    const isBest = value === best;
    if (value === median) return { atMedian: true, best: isBest, delta: null, better: null };

    const better = result.direction === "lower_is_better" ? value < median : value > median;
    return { atMedian: false, best: isBest, delta: value - median, better };
  });

  return { median, present: present.length, cells };
}

export interface OverTimeCell {
  delta: number;
  better: boolean | null;
}

export function compareOverTime(
  after: number | null,
  before: number | null,
  result: CompareFormat,
): OverTimeCell | null {
  if (after == null || before == null) return null;

  const delta = shownValue(after, result) - shownValue(before, result);
  if (delta === 0 || result.direction === "neutral") return { delta, better: null };
  return { delta, better: result.direction === "lower_is_better" ? delta < 0 : delta > 0 };
}

function formatDurationDelta(hours: number): string {
  const minutes = Math.round(hours * 60);
  return minutes > 0 && minutes < 60 ? `${minutes} min` : formatClockDuration(hours);
}

export function formatDelta(delta: number, result: ValueFormat): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const size = Math.abs(delta);

  if (result.format === "percent") return `${sign}${formatMetricNumber(size, "percent")} pp`;
  if (result.format === "currency") return `${sign}${formatMetricNumber(size, "currency")}`;
  if (isClockDuration(result.format, result.unit)) return `${sign}${formatDurationDelta(size)}`;

  const number = formatMetricNumber(size, result.format);
  return result.unit ? `${sign}${number} ${result.unit}` : `${sign}${number}`;
}

export function sharedTeam(
  entityIds: readonly string[],
  teams: ReadonlyMap<string, PersonTeam>,
): PersonTeam | null {
  const first = entityIds.length > 0 ? teams.get(entityIds[0]!) : undefined;
  if (!first) return null;

  return entityIds.every((id) => teams.get(id)?.id === first.id) ? first : null;
}

export interface TeamGroup<T> {
  team: PersonTeam | null;
  members: T[];
}

export function groupByTeam<T extends { entityId: string }>(
  people: readonly T[],
  teams: ReadonlyMap<string, PersonTeam>,
): TeamGroup<T>[] {
  const groups = new Map<string | null, TeamGroup<T>>();
  for (const person of people) {
    const team = teams.get(person.entityId) ?? null;
    const group = groups.get(team?.id ?? null);
    if (group) group.members.push(person);
    else groups.set(team?.id ?? null, { team, members: [person] });
  }
  return [...groups.values()];
}
