import { formatMetricValue } from "@/lib/format";
import { dropRedundantMetrics } from "@/lib/insight/metric-containment";
import { MIN_COHORT, quantile } from "@/lib/insight/within-team-peer";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

export type FlagKind = "outlier" | "decline" | "collapse";

export interface AttentionFlag {
  personId: string;
  name: string;
  metricKey: string;
  metricLabel: string;
  kind: FlagKind;
  moved: "up" | "down";
  valueText: string;
  reason: string;
  severity: number;
}

const OUTLIER_MIN_REL_GAP = 0.25;
const DELTA_MIN = 0.25;

export interface FlagParams {
  headlineKeys: readonly string[];
  byKey: Map<string, NormalizedMetricResult>;
  previousByKey: Map<string, NormalizedMetricResult>;
  memberIds: readonly string[];
  cohortOf: (id: string) => string | null;
  nameOf: (id: string) => string;
  personIdOf: (id: string) => string;
  cohortLabel: string;
}

function cohortScale(iqr: number, p50: number): number | null {
  if (iqr > 1e-9) return iqr;
  if (Math.abs(p50) > 1e-9) return Math.abs(p50);
  return null;
}

function severityIn(severityUnit: number | null, adverseDistance: number): number | null {
  if (severityUnit == null || !(severityUnit > 1e-9)) return null;
  const sev = adverseDistance / severityUnit;
  return Number.isFinite(sev) && sev > 0 ? sev : null;
}

export function computeAttentionFlags({
  headlineKeys,
  byKey,
  previousByKey,
  memberIds,
  cohortOf,
  nameOf,
  personIdOf,
  cohortLabel,
}: FlagParams): AttentionFlag[] {
  const out: AttentionFlag[] = [];
  for (const key of headlineKeys) {
    const r = byKey.get(key);
    if (!r || r.direction === "neutral") continue;
    const prev = previousByKey.get(key);
    const higherIsBetter = r.direction !== "lower_is_better";
    const points = memberIds
      .map((id) => ({ id, v: forEntity(r, id).value, c: cohortOf(id) }))
      .filter(
        (pt): pt is { id: string; v: number; c: string } =>
          pt.v != null && Number.isFinite(pt.v) && pt.c != null,
      );
    if (points.length < MIN_COHORT) continue;

    const byCohort = new Map<string, number[]>();
    for (const pt of points)
      (byCohort.get(pt.c) ?? byCohort.set(pt.c, []).get(pt.c)!).push(pt.v);
    const stats = new Map<
      string,
      {
        p25: number;
        p75: number;
        p50: number;
        loFence: number;
        hiFence: number;
        iqr: number;
        denom: number;
        severityUnit: number | null;
        medianText: string;
      }
    >();
    for (const [c, vals] of byCohort) {
      if (vals.length < MIN_COHORT) continue;
      const sorted = [...vals].sort((a, b) => a - b);
      const p50 = quantile(sorted, 0.5);
      const p25 = quantile(sorted, 0.25);
      const p75 = quantile(sorted, 0.75);
      const iqr = p75 - p25;
      stats.set(c, {
        p25,
        p75,
        p50,
        iqr,
        loFence: p25 - 1.5 * iqr,
        hiFence: p75 + 1.5 * iqr,
        denom: Math.abs(p50) > 1e-9 ? Math.abs(p50) : 1,
        severityUnit: cohortScale(iqr, p50),
        medianText: formatMetricValue(p50, r.format, r.unit),
      });
    }

    for (const { id, v, c } of points) {
      const absence = forEntity(r, id).absence;
      if (absence?.period_overlap) continue;
      const st = stats.get(c);
      const name = nameOf(id);
      const personId = personIdOf(id);
      const valueText = formatMetricValue(v, r.format, r.unit);
      const label = r.label;
      const relGap = st
        ? higherIsBetter
          ? (st.p50 - v) / st.denom
          : (v - st.p50) / st.denom
        : 0;

      if (higherIsBetter && v === 0 && st && st.p50 > 0) {
        const sev = severityIn(st.severityUnit, st.p50 - v);
        if (sev != null) {
          out.push({
            personId, name, metricKey: key, metricLabel: label, kind: "collapse",
            moved: "down", valueText, reason: `no ${label.toLowerCase()} — the ${cohortLabel} median is ${st.medianText}`,
            severity: sev,
          });
        }
        continue;
      }
      if (
        st &&
        st.iqr > 1e-9 &&
        (higherIsBetter ? v < st.loFence : v > st.hiFence) &&
        relGap >= OUTLIER_MIN_REL_GAP
      ) {
        const sev = severityIn(st.severityUnit, higherIsBetter ? st.p50 - v : v - st.p50);
        if (sev != null) {
          out.push({
            personId, name, metricKey: key, metricLabel: label, kind: "outlier",
            moved: higherIsBetter ? "down" : "up", valueText,
            reason: `${higherIsBetter ? "well below" : "well above"} the ${cohortLabel} median of ${st.medianText}`,
            severity: sev,
          });
        }
        continue;
      }
      if (prev && !absence?.compare_to_overlap) {
        const pv = forEntity(prev, id).value;
        if (pv != null && Number.isFinite(pv) && Math.abs(pv) > 1e-9) {
          const change = (v - pv) / Math.abs(pv);
          const adverse = higherIsBetter ? -change : change;
          const outOfPack = st
            ? higherIsBetter
              ? v < st.p25
              : v > st.p75
            : true;
          if (adverse >= DELTA_MIN && outOfPack) {
            const moved = higherIsBetter ? pv - v : v - pv;
            const sev = st ? severityIn(st.severityUnit, moved) : null;
            out.push({
              personId, name, metricKey: key, metricLabel: label, kind: "decline",
              moved: higherIsBetter ? "down" : "up", valueText,
              reason: `${higherIsBetter ? "down" : "up"} ${Math.round(adverse * 100)}% from last period`,
              severity: sev ?? adverse,
            });
          }
        }
      }
    }
  }
  const best = new Map<string, AttentionFlag>();
  for (const f of out) {
    const k = `${f.personId}::${f.metricKey}`;
    const cur = best.get(k);
    if (!cur || f.severity > cur.severity) best.set(k, f);
  }
  return thinPerPerson([...best.values()]).sort(
    (a, b) => b.severity - a.severity,
  );
}

function thinPerPerson(flags: AttentionFlag[]): AttentionFlag[] {
  const byPerson = new Map<string, AttentionFlag[]>();
  for (const f of flags) {
    const list = byPerson.get(f.personId);
    if (list) list.push(f);
    else byPerson.set(f.personId, [f]);
  }
  return [...byPerson.values()].flatMap((list) =>
    dropRedundantMetrics(
      [...list]
        .sort((a, b) => b.severity - a.severity)
        .map((flag) => ({ key: flag.metricKey, flag })),
    ).map((item) => item.flag),
  );
}

function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

export function attentionSummary(
  flags: AttentionFlag[],
  flaggedPeople: number,
  teamSize: number,
): string {
  if (flags.length === 0)
    return teamSize === 1
      ? "The one person in scope is in their usual range this period."
      : `All ${people(teamSize)} are in their usual range this period.`;
  const byMetric = new Map<string, Set<string>>();
  for (const f of flags) {
    const seen = byMetric.get(f.metricLabel) ?? new Set<string>();
    seen.add(f.personId);
    byMetric.set(f.metricLabel, seen);
  }
  const top = [...byMetric.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 2);
  const themes = top.map(([label, who]) => `${label} (${people(who.size)})`).join(", ");
  return `${flaggedPeople} of ${people(teamSize)} ${
    flaggedPeople === 1 ? "stands" : "stand"
  } out this period — most often ${themes}.`;
}

export interface AttentionTheme {
  metricKey: string;
  metricLabel: string;
  flags: AttentionFlag[];
  severity: number;
}

export function groupFlagsByTheme(
  flags: readonly AttentionFlag[]
): AttentionTheme[] {
  const byMetric = new Map<string, AttentionFlag[]>();
  for (const flag of flags) {
    byMetric.set(flag.metricKey, [...(byMetric.get(flag.metricKey) ?? []), flag]);
  }
  return [...byMetric.entries()]
    .map(([metricKey, group]) => {
      const sorted = [...group].sort((a, b) => b.severity - a.severity);
      return {
        metricKey,
        metricLabel: sorted[0]!.metricLabel,
        flags: sorted,
        severity: sorted[0]!.severity,
      };
    })
    .sort(
      (a, b) => b.flags.length - a.flags.length || b.severity - a.severity
    );
}
