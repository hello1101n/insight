import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export const MIN_COHORT = 4;

interface CohortStats {
  p25: number;
  median: number;
  p75: number;
  min: number;
  max: number;
  n: number;
}

function statsOf(values: number[]): CohortStats | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < MIN_COHORT) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  return {
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    n: sorted.length,
  };
}

export function withinCohortPeer(
  result: NormalizedMetricResult,
  memberIds: readonly string[],
  cohortOf: (id: string) => string | null,
): NormalizedMetricResult {
  const byCohort = new Map<string, number[]>();
  for (const id of memberIds) {
    const key = cohortOf(id);
    if (key == null) continue;
    const v = forEntity(result, id).value;
    if (v == null || !Number.isFinite(v)) continue;
    (byCohort.get(key) ?? byCohort.set(key, []).get(key)!).push(v);
  }
  const statsByCohort = new Map<string, CohortStats>();
  for (const [key, vals] of byCohort) {
    const s = statsOf(vals);
    if (s) statsByCohort.set(key, s);
  }

  return {
    ...result,
    peer: {
      view: "peer",
      values: memberIds.map((id) => {
        const key = cohortOf(id);
        const stats = key != null ? statsByCohort.get(key) : undefined;
        return {
          entity_id: id,
          target_value: forEntity(result, id).value,
          p25: stats?.p25 ?? null,
          median: stats?.median ?? null,
          p75: stats?.p75 ?? null,
          min: stats?.min ?? null,
          max: stats?.max ?? null,
          n: stats?.n ?? 0,
        };
      }),
    },
  };
}

export function withinTeamPeer(
  result: NormalizedMetricResult,
  memberIds: readonly string[],
): NormalizedMetricResult {
  return withinCohortPeer(result, memberIds, () => "all");
}

export function injectCohortPeer(
  personByKey: Map<string, NormalizedMetricResult>,
  cohortByKey: Map<string, NormalizedMetricResult>,
  cohortIds: readonly string[],
): Map<string, NormalizedMetricResult> {
  if (!cohortIds.length) return personByKey;
  const out = new Map(personByKey);
  for (const [key, personR] of personByKey) {
    const cohortR = cohortByKey.get(key);
    if (!cohortR) continue;
    out.set(key, {
      ...personR,
      peer: withinCohortPeer(cohortR, cohortIds, () => "all").peer,
    });
  }
  return out;
}
