import { useMemo } from "react";

import { Pending } from "@/components/portal/domain-lens-view";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { Skeleton } from "@gears-frontx/ui-kit";
import { usePortalPeriod } from "@/hooks/use-portal-period";
import type { MetricCollectionConfig } from "@/lib/metrics/collection";
import { pickTrendBucket } from "@/lib/portal/trend-data";
import type {
  TenantLensConfig,
  TenantSectionSpec,
} from "@/lib/portal/lens-configs";
import {
  collectionSetPending,
  useMetricCollection,
  useMetricCollectionSet,
} from "@/queries/metric-results";

import { CalloutPairSection } from "./callout-pair";
import { CompositionSection } from "./composition";
import { CumulativeSection } from "./cumulative";
import { DecompositionSection } from "./decomposition";
import { DumbbellSection } from "./dumbbell";
import { HeatmapHoursSection } from "./heatmap-hours";
import { HistogramSection } from "./histogram";
import { HourColumnsSection } from "./hour-columns";
import { MarginalImpactSection } from "./marginal-impact";
import { ScatterSection } from "./scatter-plot";
import { SlopeSection, MomentumSection } from "./slope-momentum";
import { SmallMultiplesSection } from "./small-multiples";
import { StackedTrendSection } from "./stacked-trend";
import { TileRow } from "./tiles";
import { TrendSection } from "./trend";
import { VerdictTableSection } from "./verdict-table";
import { splitDateRange } from "./derived";
import {
  planTenantRequests,
  sectionNeeds,
  type ResolveView,
} from "./plan";
import { tenantData } from "./data";

export function TenantLensView({ config, "data-testid": testId }: { config: TenantLensConfig; "data-testid"?: string }) {
  const { dateRange, compareTo } = usePortalPeriod();
  const bucket = pickTrendBucket(1, dateRange) ?? "month";
  const plan = useMemo(
    () => planTenantRequests(config, bucket),
    [config, bucket]
  );
  const halfRanges = useMemo(() => splitDateRange(dateRange), [dateRange]);

  const main = useMetricCollection(
    plan.collections[0],
    { type: "tenant" },
    dateRange,
    { compareTo }
  );
  const extraEntries = useMemo(
    () =>
      plan.collections
        .slice(1)
        .map((collection, index) => ({ key: extraKey(index + 1), collection })),
    [plan]
  );
  const extras = useMetricCollectionSet(
    extraEntries,
    { type: "tenant" },
    dateRange
  );
  const halvesCollection = halfRanges ? plan.halves : EMPTY_COLLECTION;
  const halves = useMetricCollection(
    halvesCollection,
    { type: "tenant" },
    halfRanges?.second ?? dateRange,
    { compareTo: halfRanges?.first }
  );

  const resolve: ResolveView = (need) => {
    const location = plan.locate(need);
    if (!location) return undefined;
    if (location.at === "first-half") {
      return halves.previousByKey?.get(need.metric);
    }
    if (location.at === "second-half") return halves.byKey.get(need.metric);
    const byKey =
      location.index === 0
        ? main.byKey
        : extras.get(extraKey(location.index))?.byKey;
    return byKey?.get(need.metric);
  };

  if (main.isPending || collectionSetPending(extras) || halves.isPending) {
    return (
      <div data-testid={testId} className="flex flex-col gap-6 p-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }
  const failed = [main, ...extras.values(), halves].filter(
    (result) => result.isError
  );
  if (failed.length > 0) {
    return (
      <div data-testid={testId} className="mx-auto w-full max-w-md p-8">
        <ComingSoon
          variant="card"
          state="error"
          label={`${config.title} — unable to load`}
          onRetry={() => failed.forEach((result) => result.refetch())}
        />
      </div>
    );
  }
  const observed = config.sections
    .flatMap((section) => sectionNeeds(section, bucket))
    .some((need) => {
      const r = resolve(need);
      if (!r) return false;
      const e = tenantData(r);
      return (
        e.value != null ||
        e.series.some((s) => s.points.some((p) => p.value != null)) ||
        e.breakdown.some((v) => v.value != null) ||
        e.histogram.some((h) => h.bins.length > 0)
      );
    });
  if (!observed) return <Pending label={config.notIngested} />;

  return (
    <div data-testid={testId} className="flex flex-col gap-6 p-6">
      <header>
        <h2 className="text-lg font-semibold">{config.title}</h2>
        {config.tagline ? (
          <p className="text-sm text-muted-foreground">{config.tagline}</p>
        ) : null}
      </header>
      {config.sections.map((section, index) => (
        <TenantSection
          key={`${section.kind}-${index}`}
          section={section}
          bucket={bucket}
          resolve={resolve}
          main={main}
        />
      ))}
    </div>
  );
}

const EMPTY_COLLECTION: MetricCollectionConfig = { metrics: [] };

function extraKey(index: number): string {
  return `extra-${index}`;
}

function TenantSection({
  section,
  bucket,
  resolve,
  main,
}: {
  section: TenantSectionSpec;
  bucket: NonNullable<ReturnType<typeof pickTrendBucket>>;
  resolve: ResolveView;
  main: ReturnType<typeof useMetricCollection>;
}) {
  switch (section.kind) {
    case "headline":
      return (
        <TileRow
          metrics={section.metrics}
          data={main.byKey}
          previous={main.previousByKey}
          minWidth="14rem"
        />
      );
    case "stat-tiles":
      return (
        <section className="flex flex-col gap-3">
          <p className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {section.title}
          </p>
          <TileRow
            metrics={section.metrics}
            data={main.byKey}
            previous={main.previousByKey}
            minWidth="11rem"
          />
        </section>
      );
    case "trend":
      return <TrendSection section={section} resolve={resolve} bucket={bucket} />;
    case "composition":
      return (
        <CompositionSection section={section} resolve={resolve} bucket={bucket} />
      );
    case "histogram":
      return <HistogramSection section={section} resolve={resolve} />;
    case "stacked-trend":
      return (
        <StackedTrendSection section={section} resolve={resolve} bucket={bucket} />
      );
    case "small-multiples":
      return (
        <SmallMultiplesSection
          section={section}
          resolve={resolve}
          bucket={bucket}
        />
      );
    case "scatter":
      return <ScatterSection section={section} resolve={resolve} bucket={bucket} />;
    case "heatmap-hours":
      return <HeatmapHoursSection section={section} resolve={resolve} />;
    case "hour-columns":
      return <HourColumnsSection section={section} resolve={resolve} />;
    case "slope":
      return <SlopeSection section={section} resolve={resolve} />;
    case "momentum":
      return <MomentumSection section={section} resolve={resolve} />;
    case "marginal-impact":
      return <MarginalImpactSection section={section} resolve={resolve} />;
    case "callout-pair":
      return <CalloutPairSection section={section} resolve={resolve} />;
    case "dumbbell":
      return <DumbbellSection section={section} resolve={resolve} />;
    case "cumulative":
      return (
        <CumulativeSection section={section} resolve={resolve} bucket={bucket} />
      );
    case "decomposition":
      return (
        <DecompositionSection section={section} resolve={resolve} bucket={bucket} />
      );
    case "verdict-table":
      return <VerdictTableSection section={section} resolve={resolve} />;
    default: {
      const _exhaustive: never = section;
      throw new Error(`Unhandled section: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
