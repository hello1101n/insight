import {
  evidenceSelection,
  personsEvidenceSelection,
} from "@/api/metric-drilldown-client";
import type {
  EvidencePeopleView,
  EvidencePersonRow,
} from "@/components/metric-evidence-context";
import { formatMetricFigure } from "@/lib/format";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import { entityValues } from "@/lib/portal/metric-stats";

export interface RosterLookups {
  nameByEntity: ReadonlyMap<string, string>;
  personIdByEntity: ReadonlyMap<string, string>;
}

export function peopleEvidenceView(
  r: NormalizedMetricResult,
  entityIds: readonly string[],
  title: string,
  roster: RosterLookups,
  records: NormalizedMetricResult | null = r
): EvidencePeopleView {
  const rows: EvidencePersonRow[] = entityValues(r, entityIds).map((entry) => {
    const name = roster.nameByEntity.get(entry.id) ?? entry.id;
    const selection = records?.drilldown
      ? evidenceSelection(records.selection, entry.id)
      : null;
    return {
      entityId: entry.id,
      personId: roster.personIdByEntity.get(entry.id) ?? null,
      name,
      value: entry.value,
      valueText: formatMetricFigure(entry.value, r.format, r.unit),
      target: selection ? { selection, label: `${r.label} · ${name}` } : null,
    };
  });
  rows.sort(
    (left, right) =>
      right.value - left.value || left.name.localeCompare(right.name)
  );

  const allRecords = records?.drilldown
    ? personsEvidenceSelection(
        records.selection,
        rows.map((row) => row.entityId)
      )
    : null;

  return {
    title,
    metricKey: r.metric_key,
    valueLabel: r.short_label ?? r.label,
    rows,
    allRecords: allRecords
      ? { selection: allRecords, label: `${r.label} · all records` }
      : null,
  };
}
