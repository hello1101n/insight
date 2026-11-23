import { ComingSoon } from "@/components/widgets/coming-soon";
import { Spinner } from "@gears-frontx/ui-kit";
import { MetricBreakdown } from "@/components/widgets/metric-views/metric-breakdown";
import { MetricHistogram } from "@/components/widgets/metric-views/metric-histogram";
import { MetricSummaryCard } from "@/components/widgets/metric-views/metric-summary-card";
import { MetricTimeseriesView } from "@/components/widgets/metric-views/metric-timeseries-view";
import type { ReactNode } from "react";

import type { DateRange } from "@/api/period-to-date-range";
import { EvidenceScopeContext } from "@/components/metric-evidence-context";
import type { DrilldownBlock, MetricGroup } from "@/lib/insight/groups";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import { collectionEvidenceTargets } from "@/lib/metrics/evidence-targets";
import type { MetricCollectionResult } from "@/queries/metric-results";
import { cn } from "@/lib/utils";

export interface CollectionDrilldownProps {
  def: MetricGroup;
  data: MetricCollectionResult;
  entityId: string;
  range?: DateRange;
  children?: ReactNode;
  className?: string;
}

function blockMetrics(
  block: DrilldownBlock,
  byKey: Map<string, NormalizedMetricResult>
): NormalizedMetricResult[] {
  if (block.view === "timeseries") return [];
  return block.metrics.flatMap((key) => {
    const metric = byKey.get(key);
    return metric ? [metric] : [];
  });
}

function Block({
  block,
  byKey,
  entityId,
}: {
  block: DrilldownBlock;
  byKey: Map<string, NormalizedMetricResult>;
  entityId: string;
}) {
  const metrics = blockMetrics(block, byKey);
  if (metrics.length === 0) return null;
  if (block.view !== "breakdown") return null;
  return (
    <>
      {metrics.map((metric) => (
        <MetricBreakdown
          key={metric.metric_key}
          metric={metric}
          entityId={entityId}
        />
      ))}
    </>
  );
}

export function CollectionDrilldown({
  def,
  data,
  entityId,
  range,
  children,
  className,
}: CollectionDrilldownProps) {
  if (data.isPending) {
    return (
      <div
        className={cn(
          "flex h-full min-h-96 w-full items-center justify-center p-10",
          className
        )}
      >
        <Spinner size="lg" />
      </div>
    );
  }

  if (data.isError) {
    return (
      <div
        className={cn(
          "flex h-full min-h-96 w-full items-center justify-center p-10",
          className
        )}
      >
        <ComingSoon
          state="error"
          label="Unable to load metrics"
          onRetry={data.refetch}
        />
      </div>
    );
  }

  const isSummaryBlock = (block: DrilldownBlock) =>
    block.view === "breakdown" && block.chart === "summary-card";
  const summaryMetrics = def.drilldown
    .filter(isSummaryBlock)
    .flatMap((block) => blockMetrics(block, data.byKey));
  const chartBlocks = def.drilldown.filter(
    (
      block
    ): block is Exclude<
      DrilldownBlock,
      { view: "timeseries" } | { view: "histogram" }
    > =>
      block.view !== "timeseries" &&
      block.view !== "histogram" &&
      !isSummaryBlock(block) &&
      blockMetrics(block, data.byKey).length > 0
  );
  const declaredDistributions = def.drilldown
    .filter((block) => block.view === "histogram")
    .flatMap((block) => blockMetrics(block, data.byKey));
  const hasDistribution = (metric: NormalizedMetricResult) =>
    (forEntity(metric, entityId).histogram[0]?.bins?.length ?? 0) > 0;
  const distributionMetrics = [
    ...declaredDistributions.filter(hasDistribution),
    ...declaredDistributions.filter((metric) => !hasDistribution(metric)),
  ];
  const timeseries = def.drilldown.filter(
    (block): block is Extract<DrilldownBlock, { view: "timeseries" }> =>
      block.view === "timeseries"
  );
  const scopeTargets = collectionEvidenceTargets(
    def.drilldown.flatMap((block) => block.metrics),
    data.byKey,
    entityId,
    range
  );

  return (
    <EvidenceScopeContext.Provider value={scopeTargets}>
      <div
        className={cn(
          "flex min-h-full flex-col gap-4 p-4 transition-opacity sm:p-6",
          data.isFetching && "opacity-60",
          className
        )}
      >
        {range && timeseries.length > 0 ? (
          <div className="grid grid-cols-1 gap-4">
            {timeseries.map((block) => (
              <MetricTimeseriesView
                key={block.id}
                id={block.id}
                entityId={entityId}
                range={range}
                metricKeys={block.metrics}
                defaultPresentation={block.defaultPresentation}
                chart={block.chart}
                groupBy={block.groupBy}
                table={block.table}
              />
            ))}
          </div>
        ) : null}
        {summaryMetrics.length > 0 ? (
          <div
            className={cn(
              "grid grid-cols-1 gap-4 sm:grid-cols-2",
              summaryMetrics.length > 2 && "xl:grid-cols-4"
            )}
          >
            {summaryMetrics.map((metric) => (
              <MetricSummaryCard
                key={metric.metric_key}
                metric={metric}
                entityId={entityId}
              />
            ))}
          </div>
        ) : null}
        {chartBlocks.length > 0 ? (
          <div
            className={cn(
              "grid grid-cols-1 gap-4",
              chartBlocks.length > 1 && "lg:grid-cols-2"
            )}
          >
            {chartBlocks.map((block, index) => (
              <Block
                key={`${block.view}-${block.chart}-${index}`}
                block={block}
                byKey={data.byKey}
                entityId={entityId}
              />
            ))}
          </div>
        ) : null}
        {children}
        {distributionMetrics.length > 0 ? (
          <div
            className={cn(
              "grid grid-cols-1 gap-4",
              distributionMetrics.length > 1 && "lg:grid-cols-2"
            )}
          >
            {distributionMetrics.map((metric) => (
              <MetricHistogram
                key={metric.metric_key}
                metric={metric}
                entityId={entityId}
              />
            ))}
          </div>
        ) : null}
      </div>
    </EvidenceScopeContext.Provider>
  );
}
