import type { MetricFormat } from "@/api/metric-results-client";
import {
  forEntity,
  type EntityMetricData,
  type MetricCollectionConfig,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { derivePeerStanding } from "@/lib/metrics/peer-standing";
import type { PeerStats, PeerStatusWithNeutral } from "@/lib/peers";
import {
  evidenceSelection,
  type MetricEvidenceSelection,
} from "@/api/metric-drilldown-client";

export type PeerStoryEntry = {
  key: string;
  label: string;
  sublabel?: string;
  value: number;
  unit: string | null;
  format: MetricFormat;
  higherIsBetter: boolean;
  neutral: boolean;
  observed: boolean;
  stats: PeerStats | null;
  status: PeerStatusWithNeutral;
  gapPct: number | null;
  gapDelta: number;
  severity: number;
  evidence?: MetricEvidenceSelection | null;
};

function toStoryEntry(
  metric: NormalizedMetricResult,
  value: number,
  data: Pick<EntityMetricData, "value" | "peer" | "absence">,
  entityId: string
): PeerStoryEntry {
  const standing = derivePeerStanding(metric.direction, data);
  return {
    key: metric.metric_key,
    label: metric.label,
    sublabel: metric.description,
    value,
    unit: metric.unit,
    format: metric.format,
    higherIsBetter: metric.direction !== "lower_is_better",
    neutral: metric.direction === "neutral",
    observed: standing.observed,
    stats: standing.stats,
    status: standing.rank,
    gapPct: standing.gapPct,
    gapDelta: standing.gapDelta,
    severity: standing.severity,
    evidence: metric.drilldown
      ? evidenceSelection(metric.selection, entityId)
      : null,
  };
}

export function buildPeerStoryEntries(
  collection: MetricCollectionConfig,
  byKey: Map<string, NormalizedMetricResult>,
  entityId: string
): PeerStoryEntry[] {
  return collection.metrics.flatMap((metricConfig) => {
    const metric = byKey.get(metricConfig.key);
    if (!metric) return [];
    const data = forEntity(metric, entityId);
    if (data.value == null || !Number.isFinite(data.value)) return [];
    return [toStoryEntry(metric, data.value, data, entityId)];
  });
}

export function worstEntry(entries: PeerStoryEntry[]): PeerStoryEntry | null {
  return (
    entries
      .filter((entry) => entry.status === "bottom")
      .sort((a, b) => b.severity - a.severity)[0] ?? null
  );
}

export interface PeerStoryPartition {
  hero: PeerStoryEntry | null;
  sideCards: PeerStoryEntry[];
  chips: PeerStoryEntry[];
  folded: PeerStoryEntry[];
}

export function partitionPeerStory(
  entries: PeerStoryEntry[]
): PeerStoryPartition {
  const bottom = entries
    .filter((entry) => entry.status === "bottom")
    .sort((a, b) => b.severity - a.severity);
  const top = entries
    .filter((entry) => entry.status === "top")
    .sort((a, b) => b.severity - a.severity);
  const folded = entries
    .filter((entry) => entry.status === "in_pack" || entry.status === "neutral")
    .sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === "neutral" ? 1 : -1;
    });

  const outliers = [...bottom, ...top];
  const hero = outliers[0] ?? null;

  return {
    hero,
    sideCards: outliers.slice(1, 4),
    chips: outliers.slice(4),
    folded,
  };
}
