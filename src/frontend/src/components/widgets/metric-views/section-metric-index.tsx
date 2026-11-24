import { MetricName } from "@/components/widgets/metric-name";
import {
  PEER_MARK_CENTRE,
  PeerMark,
} from "@/components/widgets/metric-views/peer-mark";
import { formatMetricValue } from "@/lib/format";
import { TEXT_BODY, TEXT_EYEBROW, TEXT_LABEL, TEXT_NAME } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { metricComparisons } from "@/lib/insight/metric-comparison";
import { derivePeerStanding } from "@/lib/metrics/peer-standing";
import { absenceLabel } from "@/lib/metrics/absence";
import {
  forEntity,
  type MetricCollectionConfig,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

export function SectionMetricIndex({
  collection,
  byKey,
  entityId,
  shown,
}: {
  collection: MetricCollectionConfig;
  byKey: Map<string, NormalizedMetricResult>;
  entityId: string;
  shown: ReadonlySet<string>;
}) {
  const rest = collection.metrics
    .flatMap((m) => {
      if (shown.has(m.key)) return [];
      const metric = byKey.get(m.key);
      if (!metric) return [];
      return forEntity(metric, entityId).value == null ? [] : [metric];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  if (rest.length === 0) return null;
  const leaveLabel = absenceLabel(rest[0]?.absenceContext?.get(entityId));

  return (
    <section className="rounded-xl border p-4 sm:p-5">
      <h2 className={TEXT_EYEBROW}>
        Also measured here
      </h2>
      {leaveLabel ? <p className={TEXT_LABEL}>{leaveLabel}</p> : null}
      <dl className="@container relative pt-2">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-2 w-px bg-foreground/20"
          style={{ right: PEER_MARK_CENTRE }}
        />
        {rest.map((metric) => (
          <div
            key={metric.metric_key}
            className="flex flex-wrap items-center gap-x-4 gap-y-0.5 border-b border-dashed py-1 last:border-b-0"
          >
            <dt className={cn("min-w-0 truncate", TEXT_NAME)}>
              <MetricName metric={metric} truncate />
            </dt>
            <dd className="ms-auto flex min-w-0 flex-wrap items-baseline justify-end gap-2 tabular-nums">
              <span className={cn("w-auto text-right @min-[26rem]:w-32", TEXT_BODY)}>
                {formatMetricValue(
                  forEntity(metric, entityId).value,
                  metric.format,
                  metric.unit
                )}
              </span>
              <span className={cn("w-auto text-right @min-[26rem]:w-28", TEXT_LABEL)}>
                {metricComparisons(metric, null, entityId).median ?? ""}
              </span>
              <PeerMark
                standing={derivePeerStanding(
                  metric.direction,
                  forEntity(metric, entityId)
                )}
                metricLabel={metric.label}
                format={metric.format}
                unit={metric.unit}
              />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
