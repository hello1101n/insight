import { evidenceSelection } from "@/api/metric-drilldown-client";
import { useMetricEvidenceOptional } from "@/components/metric-evidence-context";
import { formatRange } from "@/lib/date-range-label";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import { finiteValue, formatViewValue } from "@/lib/portal/metrics-view";

export function useOpenRecords(
  result: NormalizedMetricResult | undefined,
  entityId: string,
  personName: string,
): (() => void) | null {
  const evidence = useMetricEvidenceOptional();
  const value = result ? finiteValue(result, entityId) : null;
  const selection = result?.drilldown ? evidenceSelection(result.selection, entityId) : null;
  if (!result || value == null || !selection || !evidence) return null;

  return () =>
    evidence.openEvidenceTargets([{ selection, label: result.label }], {
      activeMetricKey: selection.metric_key,
      title: [
        result.label,
        personName,
        formatViewValue(value, result),
        formatRange(selection.period.from, selection.period.to),
      ].join(" · "),
    });
}
