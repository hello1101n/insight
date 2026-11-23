import { ExplainWithAi } from "@/components/widgets/dashboard/explain-with-ai";
import { trendSnapshot } from "@/lib/insight/explain-snapshot";
import { Fragment, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { BarChart, CartesianGrid, XAxis } from "recharts";
import { resolveText } from "@/i18n/localized-text";
import { MetricName } from "@/components/widgets/metric-name";
import { TrendingDown, TrendingUp } from "lucide-react";
import { AttentionList } from "@/components/portal/attention-list";
import { personDisplayName } from "@/lib/identities/person-display";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { orgScopeGate } from "@/components/portal/org-scope-gate";
import {
  SectionTrend,
  type SectionTrendPoint,
  type SectionTrendSeries,
} from "@/components/portal/section-trend";
import { ChartBar, YAxis } from "@/components/chart-series";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Card,
  CardContent,
} from "@gears-frontx/ui-kit";
import { usePortalPeriod } from "@/hooks/use-portal-period";
import {
  attentionSummary,
  computeAttentionFlags,
} from "@/lib/insight/attention-flags";
import { useIsAdmin, useVisibilityPolicy } from "@/queries/identity-me";
import { useVisibleRoster } from "@/queries/visible-roster";
import { showsUnattributedShare } from "@/lib/portal/unattributed-share";
import {
  availableSlices,
  cohortKey,
  collectRosterAttrs,
  PLANNED_SLICES,
} from "@/lib/insight/slices";
import { MIN_COHORT } from "@/lib/insight/within-team-peer";
import {
  forEntity,
  type MetricCollectionConfig,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import type {
  MetricBucket,
  MetricDirection,
} from "@/api/metric-results-client";
import { normalizePersonId } from "@/lib/metrics/entity";
import {
  useMetricEvidenceOptional,
  type EvidencePeopleView,
} from "@/components/metric-evidence-context";
import { peopleEvidenceView, type RosterLookups } from "@/lib/portal/evidence-people";
import { formatMetricValue } from "@/lib/format";
import { seriesColors } from "@/lib/series-colors";
import {
  labelForDimensionValue,
  toBarRows,
  UNSPLIT_SEGMENT,
  type BarEntry,
  type BarRow,
  type BarSegment,
} from "@/lib/portal/bar-rows";
import { narrowedEvidenceSelection } from "@/lib/metrics/evidence-targets";
import { evidenceMetricFor } from "@/lib/metrics/evidence-via";
import { useMetricDefinitionsResponse } from "@/queries/metric-definitions";
import { reachableMetricKeys } from "@/lib/insight/coverage";
import {
  dayHourMatrix,
  HOUR_BLOCKS,
  WEEKDAY_LABELS,
} from "@/lib/portal/day-hour-matrix";
import { mergeEventHistogram } from "@/lib/portal/event-histogram";
import { peerPopulationLabel } from "@/lib/portal/use-cohort-label";
import {
  bandAtClick,
  distribution,
  entityValues,
  familyObserved,
  fmtCompact,
  medianAcross,
  perCapita,
  perPersonReading,
  topDecile,
  type PerPersonReading,
} from "@/lib/portal/metric-stats";
import {
  lensEntry,
  overviewCardDirections,
  sectionMetricKeys,
  visibleSections,
  type ConcentrationFraming,
  type LensConfig,
  type SectionSpec,
} from "@/lib/portal/lens-configs";
import {
  buildActiveContributorData,
  buildMedianTrendData,
  buildTrendData,
  pickTrendBucket,
} from "@/lib/portal/trend-data";
import { bucketBreakdown, bucketRange } from "@/lib/portal/trend-drilldown";
import { runningBucketStart } from "@/lib/portal/person-trend";
import {
  TrendDrilldownDialog,
  type TrendDrilldownState,
} from "@/components/portal/trend-drilldown-dialog";
import { usePortalNavActions, usePortalSlice } from "@/lib/portal/portal-nav";
import { usePortalSearch } from "@/lib/portal/portal-search";
import { usePortalShowPlanned } from "@/lib/portal/portal-store";
import type { TeamMember } from "@/types/insight";
import { useOrgScope } from "@/lib/portal/use-org-scope";
import {
  useMetricCollection,
  useUnattributedShares,
} from "@/queries/metric-results";
import { useMemberGridData } from "@/queries/member-grid";
import { TEXT_EYEBROW, TEXT_FIGURE, TEXT_NAME } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { chartColor } from "@/lib/chart-palette";

const EMPTY_COLLECTION: MetricCollectionConfig = { metrics: [] };
const NO_METRICS: readonly string[] = [];
const DAY_MS = 86_400_000;
const OWN_NAME = "You";

export function DomainLensView({
  config: declared,
  gridKeys: gridKeysProp,
  embedded = false,
  personId = null,
  "data-testid": testId,
}: {
  "data-testid"?: string;
  config: LensConfig;
  embedded?: boolean;
  personId?: string | null;
  gridKeys?: readonly string[];
}) {
  const { t } = useTranslation();
  const { dateRange, compareTo } = usePortalPeriod();

  const [drilldown, setDrilldown] = useState<TrendDrilldownState | null>(null);
  const showPlanned = usePortalShowPlanned();
  const { repo } = usePortalSearch();
  const { openRepository } = usePortalNavActions();
  const evidence = useMetricEvidenceOptional();
  const scoped = repo && declared.drilldown ? repo : null;
  const scopeDimension = scoped ? (declared.drilldown?.dimension ?? null) : null;
  const config = useMemo(
    () =>
      visibleSections(
        scoped && declared.drilldown
          ? {
              ...declared,
              tagline: declared.drilldown.tagline ?? declared.tagline,
              sections: declared.drilldown.sections,
            }
          : declared,
        showPlanned
      ),
    [declared, showPlanned, scoped]
  );
  const title = resolveText(t, config.title);
  const scopeFilters = useMemo(
    () =>
      scopeDimension && scoped
        ? [{ dimension: scopeDimension, values: [scoped] }]
        : undefined,
    [scopeDimension, scoped]
  );


  const orgScope = useOrgScope();
  const { isFlat } = useVisibilityPolicy();
  const { pivot, roster } = orgScope;
  const members = useMemo<TeamMember[]>(
    () =>
      personId
        ? [{ person_id: personId, name: OWN_NAME }]
        : [
            ...(pivot
              ? [{ person_id: pivot.person_id, name: personDisplayName(pivot) }]
              : []),
            ...(roster ?? []).map((entry) => ({
              person_id: entry.person_id,
              name: personDisplayName(entry),
            })),
          ],
    [personId, pivot, roster]
  );
  const memberIds = useMemo(
    () => members.map((m) => normalizePersonId(m.person_id)),
    [members]
  );
  const { isAdmin } = useIsAdmin();
  const visibleRoster = useVisibleRoster(personId === null);
  const unattributedSpec = config.sections.find(
    (section): section is Extract<SectionSpec, { kind: "headline" }> =>
      section.kind === "headline" && section.unattributed === true
  );
  const readsOrganisation = showsUnattributedShare({
    personal: personId !== null,
    scoped: scoped !== null,
    mayReadOrganisation: isFlat || isAdmin,
    scopeMemberCount: memberIds.length,
    visibleCount: visibleRoster.isPending ? 0 : visibleRoster.roster.length,
  });
  const unattributedShares = useUnattributedShares(
    unattributedSpec?.metrics ?? NO_METRICS,
    unattributedSpec && readsOrganisation ? (memberIds[0] ?? null) : null,
    dateRange
  );
  const unattributedByKey = unattributedShares.byKey;
  const scopedMembers = useMemo(
    () =>
      members.map((m) => ({
        person_id: normalizePersonId(m.person_id),
        name: m.name,
      })),
    [members]
  );

  const definitions = useMetricDefinitionsResponse();
  const personalReach = useMemo(
    () =>
      personId && definitions.data
        ? reachableMetricKeys(definitions.data.metrics)
        : null,
    [personId, definitions.data]
  );

  const lensKeys = useMemo(() => sectionMetricKeys(config), [config]);
  const fetchKeys = useMemo(
    () => (gridKeysProp ? [...gridKeysProp] : lensKeys),
    [gridKeysProp, lensKeys]
  );
  const gridCollection = useMemo<MetricCollectionConfig>(
    () => ({
      metrics: fetchKeys.map((key) => ({
        key,
        ...(scopeFilters ? { filters: scopeFilters } : {}),
        views: [{ view: "period" as const }, { view: "peer" as const }],
      })),
    }),
    [fetchKeys, scopeFilters]
  );
  const grid = useMemberGridData(
    gridCollection.metrics.length ? gridCollection : EMPTY_COLLECTION,
    { type: "person", ids: memberIds },
    dateRange,
    compareTo
  );

  const trendKeys = useMemo(
    () =>
      config.sections
        .filter(
          (s): s is Extract<SectionSpec, { kind: "trend" }> =>
            s.kind === "trend"
        )
        .flatMap((s) => s.metrics),
    [config]
  );
  const trendBucket = useMemo(
    () => pickTrendBucket(memberIds.length, dateRange),
    [memberIds.length, dateRange]
  );
  const trendWindow = useMemo<TrendWindow | null>(
    () =>
      trendBucket
        ? {
            bucket: trendBucket,
            startsFrom: dateRange.from,
            finishedBefore: firstUnfinishedBucket(dateRange.to, trendBucket),
          }
        : null,
    [trendBucket, dateRange.from, dateRange.to]
  );
  const trendCollection = useMemo<MetricCollectionConfig>(
    () => ({
      metrics: trendBucket
        ? trendKeys.map((key) => ({
            key,
            ...(scopeFilters ? { filters: scopeFilters } : {}),
            views: [{ view: "timeseries" as const, bucket: trendBucket }],
          }))
        : [],
    }),
    [trendKeys, trendBucket, scopeFilters]
  );
  const trend = useMetricCollection(
    trendCollection.metrics.length && memberIds.length
      ? trendCollection
      : EMPTY_COLLECTION,
    trendCollection.metrics.length && memberIds.length
      ? { type: "person", ids: memberIds }
      : { type: "person", ids: [] },
    dateRange
  );

  const breakdownSections = useMemo(
    () =>
      config.sections.filter(
        (
          s
        ): s is Extract<SectionSpec, { kind: "composition" | "ownership" }> =>
          s.kind === "composition" || s.kind === "ownership"
      ),
    [config]
  );
  const compCollection = useMemo<MetricCollectionConfig>(() => {
    const dims = new Map<string, Set<string>>();
    for (const s of breakdownSections) {
      const set = dims.get(s.metric) ?? new Set<string>();
      set.add(s.dimension);
      if (s.kind === "composition" && s.splitBy) set.add(s.splitBy);
      dims.set(s.metric, set);
    }
    return {
      metrics: [...dims].map(([key, set]) => ({
        key,
        ...(scopeFilters ? { filters: scopeFilters } : {}),
        views: [{ view: "breakdown" as const, dimensions: [...set] }],
      })),
    };
  }, [breakdownSections, scopeFilters]);
  const compData = useMetricCollection(
    breakdownSections.length && memberIds.length
      ? compCollection
      : EMPTY_COLLECTION,
    breakdownSections.length && memberIds.length
      ? { type: "person", ids: memberIds }
      : { type: "person", ids: [] },
    dateRange
  );

  const eventSections = useMemo(
    () =>
      config.sections.filter(
        (s): s is Extract<SectionSpec, { kind: "event-histogram" }> =>
          s.kind === "event-histogram"
      ),
    [config]
  );
  const eventCollection = useMemo<MetricCollectionConfig>(
    () => ({
      metrics: eventSections.map((s) => ({
        key: s.metric,
        ...(scopeFilters ? { filters: scopeFilters } : {}),
        views: [{ view: "histogram" as const }],
      })),
    }),
    [eventSections, scopeFilters]
  );
  const eventData = useMetricCollection(
    eventSections.length && memberIds.length
      ? eventCollection
      : EMPTY_COLLECTION,
    eventSections.length && memberIds.length
      ? { type: "person", ids: memberIds }
      : { type: "person", ids: [] },
    dateRange
  );

  const tableSections = useMemo(
    () =>
      config.sections.filter(
        (s): s is Extract<SectionSpec, { kind: "dimension-table" }> =>
          s.kind === "dimension-table"
      ),
    [config]
  );
  const tableCollection = useMemo<MetricCollectionConfig>(() => {
    const dimensionByMetric = new Map<string, string>();
    for (const s of tableSections) {
      for (const key of s.metrics) {
        if (!dimensionByMetric.has(key)) dimensionByMetric.set(key, s.dimension);
      }
    }
    return {
      metrics: [...dimensionByMetric].map(([key, dimension]) => ({
        key,
        ...(scopeFilters ? { filters: scopeFilters } : {}),
        views: [{ view: "rollup" as const, dimensions: [dimension] }],
      })),
    };
  }, [tableSections, scopeFilters]);
  const tableData = useMetricCollection(
    tableSections.length && memberIds.length
      ? tableCollection
      : EMPTY_COLLECTION,
    tableSections.length && memberIds.length
      ? { type: "person", ids: memberIds }
      : { type: "person", ids: [] },
    dateRange
  );

  const hourSections = useMemo(
    () =>
      config.sections.filter(
        (s): s is Extract<SectionSpec, { kind: "heatmap-hours" }> =>
          s.kind === "heatmap-hours"
      ),
    [config]
  );
  const hourCollection = useMemo<MetricCollectionConfig>(
    () => ({
      metrics: hourSections.map((s) => ({
        key: s.metric,
        ...(scopeFilters ? { filters: scopeFilters } : {}),
        views: [
          {
            view: "timeseries" as const,
            bucket: "day" as const,
            dimensions: [HOUR_BLOCK_DIMENSION],
          },
        ],
      })),
    }),
    [hourSections, scopeFilters]
  );
  const hourData = useMetricCollection(
    hourSections.length && memberIds.length ? hourCollection : EMPTY_COLLECTION,
    hourSections.length && memberIds.length
      ? { type: "person", ids: memberIds }
      : { type: "person", ids: [] },
    dateRange
  );

  const slice = usePortalSlice();
  const attrByEntity = useMemo(
    () => collectRosterAttrs(pivot, normalizePersonId),
    [pivot]
  );
  const sliceDims = useMemo(
    () => availableSlices(attrByEntity.values()),
    [attrByEntity]
  );
  const sliceLabel = slice
    ? (sliceDims.find((d) => d.key === slice)?.label ?? slice)
    : null;

  const nameByEntity = useMemo(
    () => new Map(members.map((m) => [normalizePersonId(m.person_id), m.name])),
    [members]
  );
  const personIdByEntity = useMemo(
    () =>
      new Map(
        members.map((m) => [normalizePersonId(m.person_id), m.person_id])
      ),
    [members]
  );
  const cohortOf = useMemo(
    () => (id: string) => cohortKey(attrByEntity.get(id), slice),
    [attrByEntity, slice]
  );
  const cohortLabel = peerPopulationLabel(
    slice ? (sliceLabel ?? "cohort") : null,
    isFlat
  );

  const membersObserved = sourceConnected(
    lensKeys,
    grid.byKey,
    memberIds,
    personId ? personalReach : undefined
  );
  const sharesDecide = !membersObserved;
  const gate = orgScopeGate({
    "data-testid": testId,
    viewerLoading: !personId && orgScope.isLoading,
    viewerError: !personId && orgScope.isError,
    membersLoading: false,
    membersError: false,
    memberCount: members.length,
    gridPending: grid.isPending || (sharesDecide && unattributedShares.isPending),
    gridError: grid.isError || (sharesDecide && unattributedShares.isError),
    emptyLabel:
      "No people in the current scope. Pick a different scope at the top of the page.",
    onRetry: () => {
      orgScope.refetch();
      grid.refetch();
      unattributedShares.refetch();
    },
  });
  if (gate) return gate;

  const connected =
    membersObserved ||
    [...unattributedByKey.values()].some((value) => (value ?? 0) > 0);
  if (config.sections.length > 0 && !connected) {
    return (
      <Pending
        label={
          config.notIngested ??
          `${title} — this data source is not connected yet.`
        }
      />
    );
  }

  const scopedLabel = scoped
    ? (labelForDimensionValue(
        scopeDimension,
        scoped,
        compData.byKey,
        tableData.byKey
      ) ?? null)
    : null;

  const trendSpec = config.sections.find(
    (section): section is Extract<SectionSpec, { kind: "trend" }> =>
      section.kind === "trend"
  );
  const charts =
    trendSpec && trendWindow
      ? trendCharts(
          trendSpec,
          grid,
          trend,
          memberIds,
          personId !== null,
          trendWindow
        )
      : [];
  const drawable = charts.filter((c) => c.data.length > 1);
  const openHourBlock = (block: string) => {
    const heat = config.sections.find(
      (section): section is Extract<SectionSpec, { kind: "heatmap-hours" }> =>
        section.kind === "heatmap-hours"
    );
    const carrier = heat && grid.byKey.get(evidenceMetricFor(heat.metric));
    if (!evidence || !carrier?.drilldown) return;
    const selection = narrowedEvidenceSelection(carrier, memberIds, {
      filters: [
        ...(scopeDimension && scoped
          ? [{ dimension: scopeDimension, value: scoped }]
          : []),
        { dimension: HOUR_BLOCK_DIMENSION, value: block },
      ],
    });
    if (selection) {
      evidence.openEvidenceTargets([{ selection, label: carrier.label }], {
        activeMetricKey: selection.metric_key,
      });
    }
  };

  const openTrendDrilldown = (chart: TrendChart, bucketStart?: string) => {
    const range = bucketStart
      ? bucketRange(bucketStart, trendBucket ?? "day")
      : { from: dateRange.from, to: dateRange.to };
    const breakdown = bucketBreakdown(
      chart.drilldownKey,
      trend.byKey,
      scopedMembers
    );
    setDrilldown({
      metricKey: chart.derived ? null : chart.drilldownKey,
      label: bucketStart ? `${chart.title} · ${bucketStart}` : chart.title,
      bucketLabel: trendBucket ?? "period",
      period: range,
      members: scopedMembers,
      breakdown: trendWindow ? wholeBuckets(breakdown, trendWindow) : breakdown,
    });
  };

  return (
    <div data-testid={testId} className={cn("flex flex-col gap-6", !embedded && "p-4 md:p-6")}>
      {scoped ? (
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => openRepository("")}
            className="cursor-pointer text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {title}
          </button>
          <span aria-hidden className="text-muted-foreground">
            ›
          </span>
          <span className="font-medium">{scopedLabel ?? scoped}</span>
        </nav>
      ) : null}
      {!embedded ? <div className="relative flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {scoped ? (scopedLabel ?? scoped) : title}
          </h1>
          <p className="text-sm text-muted-foreground">
            {personId
              ? null
              : t("common.lens.scope_line", {
                  scope: orgScope.label,
                  count: members.length,
                })}
            {resolveText(t, config.tagline ?? { key: "common.lens.default_tagline" })}
          </p>
        </div>
        {drawable.length > 0 && trendBucket ? (
          <ExplainWithAi
            className="static"
            snapshot={trendSnapshot(drawable, {
              title,
              bucket: trendBucket,
              since: dateRange.from,
              until: dateRange.to,
              people: memberIds.length,
            })}
          />
        ) : null}
      </div> : null}

      {config.sections.map((s, i) => (
        <Section
          key={`${s.kind}-${i}`}
          spec={s}
          embedded={embedded}
          grid={grid}
          trend={trend}
          trendWindow={trendWindow}
          compData={compData.byKey}
          compIsError={compData.isError}
          compRefetch={compData.refetch}
          eventByKey={eventData.byKey}
          eventIsError={eventData.isError}
          hourByKey={hourData.byKey}
          hourIsError={hourData.isError}
          tableByKey={tableData.byKey}
          tableIsError={tableData.isError}
          tableRefetch={tableData.refetch}
          memberIds={memberIds}
          unattributedByKey={unattributedByKey}
          personal={personId !== null}
          personalReach={personalReach}
          cohortOf={cohortOf}
          cohortLabel={cohortLabel}
          nameByEntity={nameByEntity}
          personIdByEntity={personIdByEntity}
          onOpenChart={openTrendDrilldown}
          onOpenValue={
            !scoped && declared.drilldown
              ? (value) => openRepository(value)
              : undefined
          }
          onOpenBlock={openHourBlock}
        />
      ))}

      {slice && !personId ? (
        <ByUnitSection
          config={config}
          grid={grid.byKey}
          memberIds={memberIds}
          keyOf={(id) => attrByEntity.get(id)?.[slice]?.value ?? null}
          sliceKey={slice}
          sliceLabel={sliceLabel ?? slice}
        />
      ) : null}

      <TrendDrilldownDialog
        state={drilldown}
        onClose={() => setDrilldown(null)}
      />
    </div>
  );
}

function sourceConnected(
  keys: readonly string[],
  byKey: Map<string, NormalizedMetricResult>,
  memberIds: readonly string[],
  personalReach: ReadonlySet<string> | null | undefined
): boolean {
  if (personalReach === undefined) return familyObserved(byKey, keys, memberIds);
  if (personalReach === null) return true;
  return keys.some((key) => personalReach.has(key));
}

interface GridData {
  byKey: Map<string, NormalizedMetricResult>;
  previousByKey: Map<string, NormalizedMetricResult>;
}
interface TrendData {
  byKey: Map<string, NormalizedMetricResult>;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

function Section({
  spec,
  grid,
  trend,
  trendWindow,
  compData,
  compIsError,
  compRefetch,
  eventByKey,
  eventIsError,
  hourByKey,
  hourIsError,
  tableByKey,
  tableIsError,
  tableRefetch,
  memberIds,
  unattributedByKey,
  personal,
  personalReach,
  cohortOf,
  cohortLabel,
  nameByEntity,
  personIdByEntity,
  onOpenChart,
  onOpenValue,
  onOpenBlock,
  embedded,
}: {
  spec: SectionSpec;
  grid: GridData;
  trend: TrendData;
  trendWindow: TrendWindow | null;
  compData: Map<string, NormalizedMetricResult>;
  compIsError: boolean;
  compRefetch: () => void;
  eventByKey: Map<string, NormalizedMetricResult>;
  eventIsError: boolean;
  hourByKey: Map<string, NormalizedMetricResult>;
  hourIsError: boolean;
  tableByKey: Map<string, NormalizedMetricResult>;
  tableIsError: boolean;
  tableRefetch: () => void;
  memberIds: readonly string[];
  unattributedByKey: Map<string, number | null>;
  personal: boolean;
  personalReach: ReadonlySet<string> | null;
  nameByEntity: Map<string, string>;
  personIdByEntity: Map<string, string>;
  cohortOf: (id: string) => string | null;
  cohortLabel: string;
  onOpenChart: (chart: TrendChart, bucketStart?: string) => void;
  onOpenValue?: (value: string) => void;
  onOpenBlock?: (block: string) => void;
  embedded: boolean;
}) {
  switch (spec.kind) {
    case "headline":
      return (
        <HeadlineSection
          metrics={spec.metrics}
          labelSource={spec.labelSource}
          grid={grid}
          memberIds={memberIds}
          roster={{ nameByEntity, personIdByEntity }}
          unattributedByKey={unattributedByKey}
          embedded={embedded}
        />
      );
    case "stat-tiles":
      return (
        <StatTilesSection
          title={spec.title}
          metrics={spec.metrics}
          grid={grid}
          memberIds={memberIds}
        />
      );
    case "trend":
      return trendWindow ? (
        <TrendSection
          spec={spec}
          grid={grid}
          trend={trend}
          trendWindow={trendWindow}
          memberIds={memberIds}
          personal={personal}
          onOpenChart={onOpenChart}
        />
      ) : (
        <Pending label="Too many people over too long a period to chart at once. Pick a shorter period or a smaller scope." />
      );
    case "distribution":
      return (
        <DistributionSection
          spec={spec}
          grid={grid}
          memberIds={memberIds}
          nameByEntity={nameByEntity}
          personIdByEntity={personIdByEntity}
        />
      );
    case "concentration":
      return (
        <ConcentrationSection
          spec={spec}
          grid={grid}
          memberIds={memberIds}
          nameByEntity={nameByEntity}
          personIdByEntity={personIdByEntity}
        />
      );
    case "composition":
      return (
        <CompositionSection
          spec={spec}
          compData={compData}
          compIsError={compIsError}
          compRefetch={compRefetch}
          grid={grid}
          memberIds={memberIds}
        />
      );
    case "participation":
      return (
        <ParticipationSection
          spec={spec}
          grid={grid}
          trend={trend}
          trendWindow={trendWindow}
          memberIds={memberIds}
        />
      );
    case "event-histogram":
      return (
        <EventHistogramSection
          spec={spec}
          grid={grid}
          eventByKey={eventByKey}
          eventIsError={eventIsError}
          memberIds={memberIds}
        />
      );
    case "contributors":
      return (
        <ContributorsSection
          spec={spec}
          grid={grid}
          memberIds={memberIds}
          nameByEntity={nameByEntity}
          personIdByEntity={personIdByEntity}
        />
      );
    case "heatmap-hours":
      return (
        <HeatmapHoursSection
          spec={spec}
          hourByKey={hourByKey}
          hourIsError={hourIsError}
          memberIds={memberIds}
          onOpenBlock={onOpenBlock}
        />
      );
    case "dimension-table":
      return (
        <DimensionTableSection
          spec={spec}
          tableByKey={tableByKey}
          tableIsError={tableIsError}
          tableRefetch={tableRefetch}
          onOpenValue={onOpenValue}
        />
      );
    case "ownership":
      return (
        <OwnershipSection
          spec={spec}
          compData={compData}
          compIsError={compIsError}
          compRefetch={compRefetch}
          memberIds={memberIds}
          nameByEntity={nameByEntity}
        />
      );
    case "attention":
      return (
        <AttentionSection
          spec={spec}
          grid={grid}
          memberIds={memberIds}
          cohortOf={cohortOf}
          cohortLabel={cohortLabel}
          nameByEntity={nameByEntity}
          personIdByEntity={personIdByEntity}
        />
      );
    case "direction-cards":
      return (
        <DirectionCardsSection
          variant={spec.variant}
          grid={grid}
          memberIds={memberIds}
          personal={personal}
          personalReach={personalReach}
        />
      );
  }
}

function ParticipationSection({
  spec,
  grid,
  trend,
  trendWindow,
  memberIds,
}: {
  spec: Extract<SectionSpec, { kind: "participation" }>;
  grid: GridData;
  trend: TrendData;
  trendWindow: TrendWindow | null;
  memberIds: readonly string[];
}) {
  const isActive = (byKey: Map<string, NormalizedMetricResult>, id: string) =>
    spec.metrics.some((key) => {
      const r = byKey.get(key);
      return r != null && (forEntity(r, id).value ?? 0) > 0;
    });

  const data = useMemo(() => {
    const byDate = new Map<string, Set<string>>();
    for (const key of spec.metrics) {
      const r = trend.byKey.get(key);
      if (!r) continue;
      for (const id of memberIds) {
        for (const s of forEntity(r, id).series) {
          for (const p of s.points) {
            if ((p.value ?? 0) > 0) {
              let ids = byDate.get(p.bucket_start);
              if (!ids) byDate.set(p.bucket_start, (ids = new Set()));
              ids.add(id);
            }
          }
        }
      }
    }
    const rows = [...byDate.entries()]
      .map(([date, ids]) => ({ date, active: ids.size }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return trendWindow ? wholeBuckets(rows, trendWindow) : rows;
  }, [spec.metrics, trend.byKey, memberIds, trendWindow]);

  const active = memberIds.filter((id) => isActive(grid.byKey, id)).length;
  const prevActive = memberIds.filter((id) =>
    isActive(grid.previousByKey, id)
  ).length;
  if (memberIds.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <p className={TEXT_EYEBROW}>
        {spec.title}
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
        <Card>
          <CardContent>
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-muted-foreground">
                {spec.noun}
              </div>
              <Delta
                now={active}
                prev={prevActive || null}
                direction="higher_is_better"
              />
            </div>
            <div className={cn("mt-1", TEXT_FIGURE)}>
              {active} of {memberIds.length}
            </div>
            <div className="text-xs text-muted-foreground">
              {Math.round((active / memberIds.length) * 100)}% of the team this
              period
            </div>
          </CardContent>
        </Card>
      </div>
      {data.length > 1 ? (
        <SectionTrend
          title="Active people over time"
          series={[{ key: "active", label: spec.noun, type: "line" }]}
          data={data}
          isPending={trend.isPending}
        />
      ) : null}
    </section>
  );
}

function HeadlineSection({
  metrics,
  labelSource,
  grid,
  memberIds,
  roster,
  unattributedByKey,
  embedded,
}: {
  metrics: readonly string[];
  labelSource?: "short";
  grid: GridData;
  memberIds: readonly string[];
  roster: RosterLookups;
  unattributedByKey: Map<string, number | null>;
  embedded: boolean;
}) {
  const cards = metrics
    .map((key) => headlineCard(key, grid, memberIds, roster, unattributedByKey))
    .filter((x): x is NonNullable<typeof x> => x != null);
  if (!cards.length) return null;

  return (
    <section className="flex flex-col gap-3">
      {cards.some((c) => c.kind === "members") && (
        <p className={TEXT_EYEBROW}>
          Per person
        </p>
      )}
      <div
        className={cn(
          "grid gap-4",
          embedded
            ? "grid-cols-1 @md:grid-cols-2 @2xl:grid-cols-3"
            : "grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]"
        )}
      >
        {cards.map((c) =>
          c.kind === "members" ? (
            <HeadlineCard key={c.key} card={c} labelSource={labelSource} />
          ) : (
            <UnattributedOnlyCard key={c.key} card={c} labelSource={labelSource} />
          )
        )}
      </div>
    </section>
  );
}

function positiveShare(
  r: NormalizedMetricResult,
  key: string,
  unattributedByKey: Map<string, number | null>
): number | null {
  if (r.computation !== "sum") return null;
  const share = unattributedByKey.get(key) ?? null;
  return share != null && share > 0 ? share : null;
}

function headlineCard(
  key: string,
  grid: GridData,
  memberIds: readonly string[],
  roster: RosterLookups,
  unattributedByKey: Map<string, number | null>
) {
  const r = grid.byKey.get(key);
  if (!r) return null;

  const unattributed = positiveShare(r, key, unattributedByKey);
  const reading = perPersonReading(r, memberIds);
  if (!reading) {
    return unattributed == null
      ? null
      : { kind: "share-only" as const, key, r, unattributed };
  }

  const prev = perPersonReading(grid.previousByKey.get(key), memberIds);
  const figure = formatMetricValue(reading.value, r.format, r.unit);
  const title =
    reading.kind === "median"
      ? `${r.label} · median ${figure} per person`
      : reading.active === 0
        ? `${r.label} · no activity`
        : `${r.label} · ${figure} per active person`;
  const carrier = grid.byKey.get(evidenceMetricFor(key)) ?? null;
  const people = peopleEvidenceView(r, memberIds, title, roster, carrier);
  return {
    kind: "members" as const,
    key,
    r,
    reading,
    prev: prev?.value ?? null,
    people,
    unattributed,
  };
}

function readingCaption(reading: PerPersonReading, r: NormalizedMetricResult): string[] {
  if (reading.kind === "median") {
    return [`median of ${reading.people} ${reading.people === 1 ? "person" : "people"}`];
  }
  if (reading.active === 0) return ["no activity"];
  const people = reading.active === 1 ? "person" : "people";
  const total = formatMetricValue(reading.total, r.format, null);
  return [`average of ${reading.active} active ${people}`, `${total} total`];
}

function unattributedCaption(
  reading: PerPersonReading,
  unattributed: number | null,
  r: NormalizedMetricResult
): string[] | null {
  if (unattributed == null || reading.kind === "median") return null;
  return [
    `+ ${formatMetricValue(unattributed, r.format, null)} unattributed`,
    `${formatMetricValue(reading.total + unattributed, r.format, null)} in all`,
  ];
}

function CaptionParts({ parts }: { parts: readonly string[] }) {
  return parts.map((part, i) => (
    <Fragment key={part}>
      {i > 0 ? " · " : null}
      <span className="inline-block">{part}</span>
    </Fragment>
  ));
}

function HeadlineCard({
  card,
  labelSource,
}: {
  card: {
    r: NormalizedMetricResult;
    reading: PerPersonReading;
    prev: number | null;
    people: EvidencePeopleView;
    unattributed: number | null;
  };
  labelSource?: "short";
}) {
  const evidence = useMetricEvidenceOptional();
  const c = card;
  const share = unattributedCaption(c.reading, c.unattributed, c.r);
  const body = (
    <CardContent className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <MetricName
          metric={c.r}
          text={labelSource === "short" ? (c.r.short_label ?? c.r.label) : undefined}
          className={TEXT_NAME}
          truncate
        />
        <Delta now={c.reading.value} prev={c.prev} direction={c.r.direction} showUnavailable />
      </div>
      <div className={TEXT_FIGURE}>
        {formatMetricValue(c.reading.value, c.r.format, c.r.unit)}
      </div>
      <div className="text-xs font-medium text-muted-foreground">
        <CaptionParts parts={readingCaption(c.reading, c.r)} />
      </div>
      {share ? (
        <div data-slot="headline-unattributed" className="text-xs text-muted-foreground">
          <CaptionParts parts={share} />
        </div>
      ) : null}
    </CardContent>
  );

  if (!evidence) return <Card>{body}</Card>;

  return (
    <Card className="focus-within:ring-2 focus-within:ring-ring">
      <button
        type="button"
        aria-haspopup="dialog"
        className="w-full cursor-pointer text-left focus-visible:outline-none"
        onClick={() => evidence.openEvidencePeople(c.people)}
      >
        {body}
      </button>
    </Card>
  );
}

function UnattributedOnlyCard({
  card: c,
  labelSource,
}: {
  card: { r: NormalizedMetricResult; unattributed: number };
  labelSource?: "short";
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1">
        <MetricName
          metric={c.r}
          text={labelSource === "short" ? (c.r.short_label ?? c.r.label) : undefined}
          className={TEXT_NAME}
        />
        <div className={TEXT_FIGURE}>
          {formatMetricValue(c.unattributed, c.r.format, c.r.unit)}
        </div>
        <div
          data-slot="headline-unattributed"
          className="text-xs font-medium text-muted-foreground"
        >
          all unattributed · no person reached
        </div>
      </CardContent>
    </Card>
  );
}

function StatTilesSection({
  title,
  metrics,
  grid,
  memberIds,
}: {
  title: string;
  metrics: readonly string[];
  grid: GridData;
  memberIds: readonly string[];
}) {
  const tiles = metrics
    .map((key) => {
      const r = grid.byKey.get(key);
      if (!r) return null;
      const median = medianAcross(r, memberIds);
      if (median == null) return null;
      const prev = medianAcross(grid.previousByKey.get(key), memberIds);
      return { key, r, median, prev };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
  if (!tiles.length) return null;

  return (
    <section className="flex flex-col gap-3">
      <p className={TEXT_EYEBROW}>
        {title}
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3">
        {tiles.map((t) => (
          <Card key={t.key}>
            <CardContent>
              <div className="flex items-center justify-between gap-2">
                <MetricName
                  metric={t.r}
                  text={t.r.short_label ?? t.r.label}
                  className="text-xs font-medium text-muted-foreground"
                />
                <Delta now={t.median} prev={t.prev} direction={t.r.direction} />
              </div>
              <div className={cn("mt-1", TEXT_FIGURE)}>
                {formatMetricValue(t.median, t.r.format, t.r.unit)}
              </div>
              <div className="text-xs text-muted-foreground">
                median / person
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

export interface TrendChart {
  id: string;
  title: string;
  description: string;
  drilldownKey: string;
  derived?: boolean;
  series: SectionTrendSeries[];
  data: SectionTrendPoint[];
}

interface TrendWindow {
  bucket: MetricBucket;
  startsFrom: string;
  finishedBefore: string;
}

function firstUnfinishedBucket(rangeTo: string, bucket: MetricBucket): string {
  return runningBucketStart(dayAfter(rangeTo), bucket);
}

function dayAfter(isoDate: string): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function wholeBuckets<T extends { date: string }>(
  rows: readonly T[],
  trendWindow: TrendWindow
): T[] {
  return rows.filter(
    (row) =>
      row.date >= trendWindow.startsFrom &&
      row.date < trendWindow.finishedBefore
  );
}

function trendCharts(
  spec: Extract<SectionSpec, { kind: "trend" }>,
  grid: GridData,
  trend: TrendData,
  memberIds: readonly string[],
  personal: boolean,
  trendWindow: TrendWindow
): TrendChart[] {
  const charts = spec.metrics
    .map((key): TrendChart | null => {
      const r = grid.byKey.get(key);
      if (!r) return null;
      const label = r.short_label ?? r.label;
      if (r.computation !== "sum") {
        return {
          id: key,
          title: label,
          description: personal ? "Your value" : "Median per person",
          drilldownKey: key,
          derived: true,
          series: [{ key, label, type: "line" as const }],
          data: wholeBuckets(
            buildMedianTrendData(key, trend.byKey, memberIds),
            trendWindow
          ),
        };
      }
      return {
        id: key,
        title: label,
        description: personal ? "Your total" : "Team total",
        drilldownKey: key,
        series: [{ key, label, type: "line" as const }],
        data: wholeBuckets(
          buildTrendData([key], trend.byKey, memberIds),
          trendWindow
        ),
      };
    })
    .filter((c): c is TrendChart => c != null);

  const activeKey = spec.activeContributorsFor;
  if (activeKey && grid.byKey.has(activeKey)) {
    const of = grid.byKey.get(activeKey);
    charts.push({
      id: `${activeKey}:active`,
      title: `Active contributors · ${of?.short_label ?? of?.label ?? activeKey}`,
      description: "People with at least one",
      drilldownKey: activeKey,
      derived: true,
      series: [{ key: "active", label: "People", type: "line" as const }],
      data: wholeBuckets(
        buildActiveContributorData(activeKey, trend.byKey, memberIds),
        trendWindow
      ),
    });
  }

  return charts;
}

function TrendSection({
  spec,
  grid,
  trend,
  trendWindow,
  memberIds,
  personal,
  onOpenChart,
}: {
  spec: Extract<SectionSpec, { kind: "trend" }>;
  grid: GridData;
  trend: TrendData;
  trendWindow: TrendWindow;
  memberIds: readonly string[];
  personal: boolean;
  onOpenChart: (chart: TrendChart, bucketStart?: string) => void;
}) {
  const charts = trendCharts(
    spec,
    grid,
    trend,
    memberIds,
    personal,
    trendWindow
  );

  if (charts.length === 0) return null;
  if (trend.isError)
    return (
      <SectionTrend
        title="Activity over time"
        series={charts[0]?.series ?? []}
        data={[]}
        isError
        onRetry={trend.refetch}
      />
    );

  const drawable = charts.filter((c) => c.data.length > 1);
  if (drawable.length === 0) return null;

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(34rem,100%),1fr))] gap-4">
      {drawable.map((chart) => (
        <button
          key={chart.id}
          type="button"
          className="rounded-xl text-left transition-opacity hover:opacity-90 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
          onClick={() => onOpenChart(chart)}
          aria-label={`Open ${chart.title} details`}
        >
          <SectionTrend
            title={chart.title}
            description={`${chart.description} · per ${trendWindow.bucket}`}
            series={chart.series}
            data={chart.data}
            isPending={trend.isPending}
            onBucketClick={(bucketStart) => onOpenChart(chart, bucketStart)}
          />
        </button>
      ))}
    </div>
  );
}

const DIST_CONFIG: ChartConfig = { count: { label: "People" } };

function DistributionSection({
  spec,
  grid,
  memberIds,
  nameByEntity,
  personIdByEntity,
}: {
  spec: Extract<SectionSpec, { kind: "distribution" }>;
  grid: GridData;
  memberIds: readonly string[];
  nameByEntity: Map<string, string>;
  personIdByEntity: Map<string, string>;
}) {
  const evidence = useMetricEvidenceOptional();
  const r = grid.byKey.get(spec.metric);
  const entries = entityValues(r, memberIds).filter((e) => e.value >= 0);
  const fmt =
    r?.format === "percent"
      ? (n: number) => formatMetricValue(n, "percent", null)
      : fmtCompact;
  const rows = distribution(entries, fmt);
  if (!rows.length || !r) return null;

  const bandsByRange = new Map(
    evidence
      ? rows.flatMap((row) =>
          row.count
            ? ([
                [
                  row.range,
                  peopleEvidenceView(
                    r,
                    row.ids,
                    `${r.label} · ${row.range} ${spec.unitLabel}`,
                    { nameByEntity, personIdByEntity }
                  ),
                ],
              ] as const)
            : []
        )
      : []
  );
  const openBand = (range: string) => {
    const view = bandsByRange.get(range);
    if (view) evidence?.openEvidencePeople(view);
  };

  return (
    <section className="flex flex-col gap-3">
      <p className={TEXT_EYEBROW}>
        {spec.title} · {entries.length} people
      </p>
      <Card>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">{spec.caption}</p>
          <ChartContainer
            config={DIST_CONFIG}
            className={cn("h-56 w-full", bandsByRange.size && "cursor-pointer")}
          >
            <BarChart
              data={rows}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              onClick={(next) => {
                const row = bandAtClick(rows, next);
                if (row) openBand(row.range);
              }}
            >
              <CartesianGrid
                vertical={false}
                strokeDasharray="3 3"
                stroke="var(--border)"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                width={28}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    className="min-w-40"
                    labelFormatter={(_, p) =>
                      (p?.[0]?.payload as { range?: string } | undefined)
                        ?.range ?? ""
                    }
                  />
                }
              />
              <ChartBar
                dataKey="count"
                name="People"
                fill={chartColor(0)}
              />
            </BarChart>
          </ChartContainer>
          <p className="mt-1 text-center text-xs text-muted-foreground">
            {spec.unitLabel}
          </p>
          {bandsByRange.size > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                See who is in a band
              </p>
              <div className="flex flex-wrap gap-1.5">
                {rows
                  .filter((row) => bandsByRange.has(row.range))
                  .map((row) => (
                    <button
                      key={row.range}
                      type="button"
                      aria-haspopup="dialog"
                      aria-label={`${row.range} ${spec.unitLabel} · ${row.count} ${row.count === 1 ? "person" : "people"}`}
                      onClick={() => openBand(row.range)}
                      className="cursor-pointer rounded-sm border px-2 py-0.5 text-xs hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <span className="tabular-nums">{row.range}</span>
                      <span className="ml-1.5 text-muted-foreground tabular-nums">
                        {row.count}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function EventHistogramSection({
  spec,
  grid,
  eventByKey,
  eventIsError,
  memberIds,
}: {
  spec: Extract<SectionSpec, { kind: "event-histogram" }>;
  grid: GridData;
  eventByKey: Map<string, NormalizedMetricResult>;
  eventIsError: boolean;
  memberIds: readonly string[];
}) {
  if (eventIsError) return null;
  const r = grid.byKey.get(spec.metric);
  const bins = mergeEventHistogram(eventByKey.get(spec.metric), memberIds);
  if (!bins) return null;

  const fmt =
    r?.format === "percent"
      ? (n: number) => formatMetricValue(n, "percent", null)
      : fmtCompact;
  const rows = bins.map((bin) => ({
    label: fmt(bin.lo),
    range: `${fmt(bin.lo)}–${fmt(bin.hi)}`,
    count: bin.count,
  }));
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);

  return (
    <section className="flex flex-col gap-3">
      <p className={TEXT_EYEBROW}>
        {spec.title} · {total} events
      </p>
      <Card>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">
            Distribution of events (every PR), not people.
          </p>
          <ChartContainer config={DIST_CONFIG} className="h-56 w-full">
            <BarChart
              data={rows}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                vertical={false}
                strokeDasharray="3 3"
                stroke="var(--border)"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                allowDecimals={false}
                width={28}
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    className="min-w-40"
                    labelFormatter={(_, p) =>
                      (p?.[0]?.payload as { range?: string } | undefined)
                        ?.range ?? ""
                    }
                  />
                }
              />
              <ChartBar
                dataKey="count"
                name="Events"
                fill={chartColor(0)}
              />
            </BarChart>
          </ChartContainer>
          <p className="mt-1 text-center text-xs text-muted-foreground">
            {r?.short_label ?? r?.label ?? spec.metric}
            {r?.unit ? ` (${r.unit})` : ""}
          </p>
        </CardContent>
      </Card>
    </section>
  );
}

const FRAMING_COPY: Record<
  ConcentrationFraming,
  { heading: string; note: string }
> = {
  "bus-factor": {
    heading: "How much of the work sits with the busiest tenth",
    note: "high concentration = continuity risk",
  },
  "load-balance": {
    heading: "How much of the load sits with the busiest tenth",
    note: "even share ≈ 10%",
  },
};

function ConcentrationSection({
  spec,
  grid,
  memberIds,
  nameByEntity,
  personIdByEntity,
}: {
  spec: Extract<SectionSpec, { kind: "concentration" }>;
  grid: GridData;
  memberIds: readonly string[];
  nameByEntity: Map<string, string>;
  personIdByEntity: Map<string, string>;
}) {
  const cards = spec.metrics
    .map((key) => {
      const r = grid.byKey.get(key);
      if (!r) return null;
      const contributors = entityValues(r, memberIds).filter(
        (e) => e.value > 0
      );
      const top = topDecile(contributors);
      if (!top) return null;
      const subset = `busiest ${top.ids.length} of ${contributors.length}`;
      return {
        key,
        label: r.short_label ?? r.label,
        share: top.share,
        subset,
        people: peopleEvidenceView(r, top.ids, `${r.label} · ${subset}`, {
          nameByEntity,
          personIdByEntity,
        }),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);
  if (!cards.length) return null;
  const copy = FRAMING_COPY[spec.framing];

  return (
    <section className="flex flex-col gap-3">
      <p className={TEXT_EYEBROW}>
        {copy.heading}
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
        {cards.map((c) => (
          <ConcentrationCard key={c.key} card={c} note={copy.note} />
        ))}
      </div>
    </section>
  );
}

const CONCENTRATION_NAMES = 5;

function concentrationNames(people: EvidencePeopleView): string {
  const names = people.rows.map((row) => row.name);
  const shown = names.slice(0, CONCENTRATION_NAMES).join(", ");
  const rest = names.length - CONCENTRATION_NAMES;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

function ConcentrationCard({
  card,
  note,
}: {
  card: {
    label: string;
    share: number;
    subset: string;
    people: EvidencePeopleView;
  };
  note: string;
}) {
  const evidence = useMetricEvidenceOptional();
  const c = card;
  const body = (
    <CardContent>
      <div className="text-xs font-medium text-muted-foreground">{c.label}</div>
      <div className={cn("mt-1", TEXT_FIGURE)}>
        {Math.round(c.share * 100)}%
      </div>
      <div className="text-xs text-muted-foreground">
        carried by the {c.subset} · {note}
      </div>
      {c.people.rows.length ? (
        <div className="mt-2 text-sm">{concentrationNames(c.people)}</div>
      ) : null}
    </CardContent>
  );

  if (!evidence || !c.people.rows.length) return <Card>{body}</Card>;

  return (
    <Card className="focus-within:ring-2 focus-within:ring-ring">
      <button
        type="button"
        aria-haspopup="dialog"
        className="w-full cursor-pointer text-left focus-visible:outline-none"
        onClick={() => evidence.openEvidencePeople(c.people)}
      >
        {body}
      </button>
    </Card>
  );
}

function CompositionSection({
  spec,
  compData,
  compIsError,
  compRefetch,
  grid,
  memberIds,
}: {
  spec: Extract<SectionSpec, { kind: "composition" }>;
  compData: Map<string, NormalizedMetricResult>;
  compIsError: boolean;
  compRefetch: () => void;
  grid: GridData;
  memberIds: readonly string[];
}) {
  const evidence = useMetricEvidenceOptional();
  const definitions = useMetricDefinitionsResponse().data?.metrics;
  if (compIsError) {
    return (
      <section className="flex flex-col gap-3">
        <p className={TEXT_EYEBROW}>
          {spec.title}
        </p>
        <ComingSoon
          variant="card"
          state="error"
          label={`${spec.title} — unable to load`}
          onRetry={compRefetch}
        />
      </section>
    );
  }

  const r = grid.byKey.get(spec.metric);
  const bd = compData.get(spec.metric);
  const bucket = new Map<string, BarEntry>();
  if (bd) {
    for (const id of memberIds) {
      for (const row of forEntity(bd, id).breakdown) {
        const dim = row.dimensions.find((d) => d.key === spec.dimension);
        if (!dim?.value || row.value == null || row.value <= 0) continue;
        const running = bucket.get(dim.value);
        const split = running?.split ?? (spec.splitBy ? new Map() : undefined);
        if (split && spec.splitBy) {
          const by = row.dimensions.find((d) => d.key === spec.splitBy);
          const seed = by?.value || UNSPLIT_SEGMENT;
          const seen = split.get(seed);
          split.set(seed, {
            seed,
            label: by?.label?.trim() || seen?.label || seed,
            value: (seen?.value ?? 0) + row.value,
          });
        }
        const label = dim.label?.trim() || running?.label || dim.value;
        const href = running?.href ?? dim.href;
        bucket.set(dim.value, {
          label,
          value: (running?.value ?? 0) + row.value,
          href,
          split,
        });
      }
    }
  }
  const rows = toBarRows(bucket, spec.splitBy);
  if (rows.length < 2) return null;

  const declared = (key: string) =>
    definitions?.find((d) => d.metric_key === key)?.dimensions;
  const clicked = (row: BarRow, segment?: BarSegment) => [
    { dimension: spec.dimension, value: row.key },
    ...(segment && spec.splitBy
      ? [{ dimension: spec.splitBy, value: segment.seed }]
      : []),
  ];
  const recordsBehind = (filters: readonly { dimension: string }[]) =>
    grid.byKey.get(
      evidenceMetricFor(
        spec.metric,
        filters.map((f) => f.dimension),
        declared
      )
    );
  const canOpen = (row: BarRow, segment?: BarSegment) =>
    segment?.seed !== UNSPLIT_SEGMENT &&
    Boolean(recordsBehind(clicked(row, segment))?.drilldown);
  const anyOpens = rows.some((row) =>
    row.segments?.length
      ? row.segments.some((segment) => canOpen(row, segment))
      : canOpen(row)
  );
  const openBar =
    evidence && anyOpens
      ? (row: BarRow, segment?: BarSegment) => {
          const filters = clicked(row, segment);
          const records = recordsBehind(filters);
          const selection = narrowedEvidenceSelection(records, memberIds, {
            filters,
          });
          if (records && selection) {
            evidence.openEvidenceTargets(
              [{ selection, label: records.label }],
              { activeMetricKey: selection.metric_key }
            );
          }
        }
      : undefined;

  return (
    <BarList
      title={spec.title}
      rows={rows}
      format={r?.format ?? "integer"}
      unit={r?.unit ?? null}
      notes={spec.notes}
      onOpen={openBar}
      canOpen={canOpen}
    />
  );
}

const CONTRIBUTOR_ROWS = 8;

function ContributorsSection({
  spec,
  grid,
  memberIds,
  nameByEntity,
  personIdByEntity,
}: {
  spec: Extract<SectionSpec, { kind: "contributors" }>;
  grid: GridData;
  memberIds: readonly string[];
  nameByEntity: Map<string, string>;
  personIdByEntity: Map<string, string>;
}) {
  const evidence = useMetricEvidenceOptional();
  const r = grid.byKey.get(spec.metric);
  if (!r) return null;

  const carrier = grid.byKey.get(evidenceMetricFor(spec.metric)) ?? null;
  const people = peopleEvidenceView(
    r,
    memberIds,
    spec.title,
    { nameByEntity, personIdByEntity },
    carrier
  );
  const targetByEntity = new Map(
    people.rows.flatMap((row) =>
      row.target ? [[row.entityId, row.target] as const] : []
    )
  );

  const ranked = entityValues(r, memberIds)
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value);
  if (ranked.length < 2) return null;

  const limit = spec.limit ?? CONTRIBUTOR_ROWS;
  const bucket = new Map<string, BarEntry>();
  for (const entry of ranked.slice(0, limit)) {
    bucket.set(entry.id, {
      label: nameByEntity.get(entry.id) ?? entry.id,
      value: entry.value,
    });
  }
  const rest = ranked.slice(limit);
  if (rest.length) {
    bucket.set("__rest__", {
      label: `${rest.length} more ${rest.length === 1 ? "person" : "people"}`,
      value: rest.reduce((sum, e) => sum + e.value, 0),
    });
  }

  const openPerson = (row: BarRow) => {
    const target = targetByEntity.get(row.key);
    if (target) evidence?.openEvidence(target.selection, target.label);
  };

  return (
    <BarList
      title={spec.title}
      rows={toBarRows(bucket)}
      format={r.format}
      unit={r.unit}
      onOpen={evidence && targetByEntity.size ? openPerson : undefined}
      canOpen={(row) => targetByEntity.has(row.key)}
    />
  );
}

function HeatmapHoursSection({
  spec,
  hourByKey,
  hourIsError,
  memberIds,
  onOpenBlock,
}: {
  spec: Extract<SectionSpec, { kind: "heatmap-hours" }>;
  hourByKey: Map<string, NormalizedMetricResult>;
  hourIsError: boolean;
  memberIds: readonly string[];
  onOpenBlock?: (block: string) => void;
}) {
  if (hourIsError) return null;
  const r = hourByKey.get(spec.metric);
  if (!r) return null;

  const { cells, max, total } = dayHourMatrix(
    memberIds.flatMap((id) => forEntity(r, id).series)
  );
  if (total <= 0 || max <= 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <p className={TEXT_EYEBROW}>
        {spec.title} · {formatMetricValue(total, r.format, r.unit)}
      </p>
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div
            className="grid gap-px text-xs"
            style={{
              gridTemplateColumns: `3rem repeat(${HOUR_BLOCKS.length}, 1fr)`,
            }}
          >
            <div />
            {HOUR_BLOCKS.map((block, index) => (
              <div key={block} className="text-center text-muted-foreground">
                {onOpenBlock ? (
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    aria-label={`Open the records from the ${block}:00 block`}
                    onClick={() => onOpenBlock(block)}
                    className="w-full cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
                  >
                    <span aria-hidden={index % 2 !== 0}>
                      {index % 2 === 0 ? block : "·"}
                    </span>
                  </button>
                ) : (
                  <span>{index % 2 === 0 ? block : ""}</span>
                )}
              </div>
            ))}
            {WEEKDAY_LABELS.map((day, dayIndex) => (
              <Fragment key={day}>
                <div className="self-center text-muted-foreground">{day}</div>
                {HOUR_BLOCKS.map((block, blockIndex) => {
                  const value = cells[dayIndex]?.[blockIndex] ?? 0;
                  return (
                    <div
                      key={block}
                      title={`${day} ${block}:00 · ${formatMetricValue(value, r.format, r.unit)}`}
                      className="aspect-square rounded-[3px]"
                      style={{
                        backgroundColor: value
                          ? `color-mix(in oklab, var(--primary) ${Math.round((value / max) * 100)}%, var(--muted))`
                          : "var(--muted)",
                      }}
                    />
                  );
                })}
              </Fragment>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{spec.caption}</p>
        </CardContent>
      </Card>
    </section>
  );
}

const DIMENSION_TABLE_ROWS = 12;

const HOUR_BLOCK_DIMENSION = "hour_block";

function tableCellText(
  value: number | null | undefined,
  result: NormalizedMetricResult
): string {
  return value == null ? "—" : formatMetricValue(value, result.format, result.unit);
}

function DimensionTableSection({
  spec,
  tableByKey,
  tableIsError,
  tableRefetch,
  onOpenValue,
}: {
  spec: Extract<SectionSpec, { kind: "dimension-table" }>;
  tableByKey: Map<string, NormalizedMetricResult>;
  tableIsError: boolean;
  tableRefetch: () => void;
  onOpenValue?: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (tableIsError) {
    return (
      <section className="flex flex-col gap-3">
        <p className={TEXT_EYEBROW}>
          {spec.title}
        </p>
        <ComingSoon
          variant="card"
          state="error"
          label={`${spec.title} — unable to load`}
          onRetry={tableRefetch}
        />
      </section>
    );
  }

  const results = spec.metrics
    .map((key) => tableByKey.get(key))
    .filter((r): r is NormalizedMetricResult => r?.rollup != null);
  const primary = results[0];
  if (!primary?.rollup) return null;

  type Row = {
    value: string;
    label: string;
    persons: number | null;
    cells: Map<string, number | null>;
  };
  const rows = new Map<string, Row>();
  for (const r of results) {
    for (const v of r.rollup?.values ?? []) {
      const dim = v.dimensions.find((d) => d.key === spec.dimension);
      if (!dim?.value) continue;
      const row: Row = rows.get(dim.value) ?? {
        value: dim.value,
        label: dim.value,
        persons: null,
        cells: new Map(),
      };
      if (dim.label?.trim()) row.label = dim.label.trim();
      row.cells.set(r.metric_key, v.value);
      if (r.metric_key === primary.metric_key) {
        row.persons = v.contributing_entity_count;
      }
      rows.set(dim.value, row);
    }
  }
  const ranked = [...rows.values()].sort(
    (a, b) =>
      (b.cells.get(primary.metric_key) ?? 0) -
      (a.cells.get(primary.metric_key) ?? 0)
  );
  if (ranked.length < 2) return null;

  const limit = spec.limit ?? DIMENSION_TABLE_ROWS;
  const visible = expanded ? ranked : ranked.slice(0, limit);
  const rest = expanded ? [] : ranked.slice(limit);
  const remainder = rest.length
    ? {
        label: `Other (${rest.length})`,
        cells: new Map<string, number | null>(
          results.map((r) => [
            r.metric_key,
            r.computation === "sum"
              ? rest.reduce(
                  (sum, row) => sum + (row.cells.get(r.metric_key) ?? 0),
                  0
                )
              : null,
          ])
        ),
      }
    : null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className={TEXT_EYEBROW}>
          {spec.title} · {ranked.length} {spec.noun}
        </p>
        {expanded && ranked.length > limit ? (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Show top {limit}
          </button>
        ) : null}
      </div>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                {results.map((r) => (
                  <TableHead key={r.metric_key} className="text-right">
                    {r.short_label ?? r.label}
                  </TableHead>
                ))}
                <TableHead className="text-right">People</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={row.value}>
                  <TableCell
                    className="max-w-64 truncate"
                    title={row.label}
                  >
                    {onOpenValue ? (
                      <button
                        type="button"
                        onClick={() => onOpenValue(row.value)}
                        className="max-w-full cursor-pointer truncate underline-offset-2 hover:underline"
                      >
                        {row.label}
                      </button>
                    ) : (
                      row.label
                    )}
                  </TableCell>
                  {results.map((r) => (
                    <TableCell
                      key={r.metric_key}
                      className="text-right tabular-nums"
                    >
                      {tableCellText(row.cells.get(r.metric_key), r)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right tabular-nums">
                    {row.persons ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
              {remainder ? (
                <TableRow>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setExpanded(true)}
                      className="cursor-pointer underline-offset-2 hover:text-foreground hover:underline"
                    >
                      {remainder.label}
                    </button>
                  </TableCell>
                  {results.map((r) => (
                    <TableCell
                      key={r.metric_key}
                      className="text-right tabular-nums"
                    >
                      {tableCellText(remainder.cells.get(r.metric_key), r)}
                    </TableCell>
                  ))}
                  <TableCell className="text-right">—</TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}

const OWNERSHIP_RISK_SHARE = 0.6;
const OWNERSHIP_ROWS = 12;

function ownershipPct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function OwnershipSection({
  spec,
  compData,
  compIsError,
  compRefetch,
  memberIds,
  nameByEntity,
}: {
  spec: Extract<SectionSpec, { kind: "ownership" }>;
  compData: Map<string, NormalizedMetricResult>;
  compIsError: boolean;
  compRefetch: () => void;
  memberIds: readonly string[];
  nameByEntity: Map<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (compIsError) {
    return (
      <section className="flex flex-col gap-3">
        <p className={TEXT_EYEBROW}>
          {spec.title}
        </p>
        <ComingSoon
          variant="card"
          state="error"
          label={`${spec.title} — unable to load`}
          onRetry={compRefetch}
        />
      </section>
    );
  }

  const bd = compData.get(spec.metric);
  const byValue = new Map<
    string,
    { label: string; total: number; byEntity: Map<string, number> }
  >();
  if (bd) {
    for (const id of memberIds) {
      for (const row of forEntity(bd, id).breakdown) {
        const dim = row.dimensions.find((d) => d.key === spec.dimension);
        if (!dim?.value || row.value == null || row.value <= 0) continue;
        const bucket = byValue.get(dim.value) ?? {
          label: dim.value,
          total: 0,
          byEntity: new Map<string, number>(),
        };
        if (dim.label?.trim()) bucket.label = dim.label.trim();
        bucket.total += row.value;
        bucket.byEntity.set(id, (bucket.byEntity.get(id) ?? 0) + row.value);
        byValue.set(dim.value, bucket);
      }
    }
  }
  const rows = [...byValue.entries()]
    .map(([value, bucket]) => {
      const ranked = [...bucket.byEntity.entries()].sort((a, b) => b[1] - a[1]);
      const shares = ranked.map(([, share]) => share);
      const top1 = (shares[0] ?? 0) / bucket.total;
      const top3 =
        shares.slice(0, 3).reduce((sum, v) => sum + v, 0) / bucket.total;
      const nameOf = ([id]: [string, number]) => nameByEntity.get(id) ?? id;
      return {
        value,
        label: bucket.label,
        total: bucket.total,
        top1,
        top3,
        topName: ranked[0] ? nameOf(ranked[0]) : null,
        nextNames: ranked.slice(1, 3).map(nameOf),
        othersCount: Math.max(0, ranked.length - 3),
      };
    })
    .sort((a, b) => b.total - a.total);
  if (rows.length < 2) return null;
  const visible = expanded ? rows : rows.slice(0, OWNERSHIP_ROWS);

  return (
    <section className="flex flex-col gap-3">
      <p className={TEXT_EYEBROW}>
        {spec.title}
      </p>
      <Card>
        <CardContent className="flex flex-col gap-2">
          <ul
          className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-1"
          aria-label="What each colour in a bar means"
          >
          <li className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="size-2.5 shrink-0 rounded-[2px] bg-primary" />
            Top person
          </li>
          <li className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="size-2.5 shrink-0 rounded-[2px] bg-primary/50" />
            Next 2
          </li>
          <li className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="size-2.5 shrink-0 rounded-[2px] border border-border bg-muted" />
            Everyone else
          </li>
          </ul>
          {visible.map((row) => (
          <div key={row.value} className="flex items-center gap-3">
            <div
              className="w-44 shrink-0 truncate text-sm md:w-64 lg:w-80"
              title={row.label}
            >
              {row.label}
            </div>
            <div
              className="flex h-3.5 flex-1 gap-0.5"
              role="img"
              aria-label={`${row.label}: top person ${ownershipPct(row.top1)}, top three ${ownershipPct(row.top3)}`}
            >
              <OwnershipSegment
                className="rounded-[3px] bg-primary"
                width={row.top1 * 100}
                who={row.topName ? [row.topName] : []}
                share={ownershipPct(row.top1)}
                role="Top person"
              />
              {row.top3 > row.top1 ? (
                <OwnershipSegment
                  className="rounded-[3px] bg-primary/50"
                  width={(row.top3 - row.top1) * 100}
                  who={row.nextNames}
                  share={ownershipPct(row.top3 - row.top1)}
                  role="Next 2"
                />
              ) : null}
              {row.top3 < 1 ? (
                <OwnershipSegment
                  className="rounded-[3px] border border-border bg-muted"
                  width={(1 - row.top3) * 100}
                  who={[]}
                  share={ownershipPct(1 - row.top3)}
                  role={
                    row.othersCount
                      ? `Everyone else · ${row.othersCount} ${row.othersCount === 1 ? "person" : "people"}`
                      : "Everyone else"
                  }
                />
              ) : null}
            </div>
            <div className="w-40 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              <span
                className={
                  row.top1 >= OWNERSHIP_RISK_SHARE
                    ? "font-medium text-warning"
                    : "font-medium text-foreground"
                }
              >
                top-1 {ownershipPct(row.top1)}
              </span>{" "}
              · top-3 {ownershipPct(row.top3)}
            </div>
          </div>
          ))}
          {rows.length > visible.length || expanded ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="cursor-pointer self-start pt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {expanded
              ? `Show top ${OWNERSHIP_ROWS}`
              : `+${rows.length - visible.length} more`}
          </button>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function OwnershipSegment({
  className,
  width,
  who,
  share,
  role,
}: {
  className: string;
  width: number;
  who: readonly string[];
  share: string;
  role: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={className} style={{ width: `${width}%` }} />}
      />
      <TooltipContent side="top">
        {role} · {share}
        {who.length ? ` · ${who.join(", ")}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

function AttentionSection({
  spec,
  grid,
  memberIds,
  cohortOf,
  cohortLabel,
  nameByEntity,
  personIdByEntity,
}: {
  spec: Extract<SectionSpec, { kind: "attention" }>;
  grid: GridData;
  memberIds: readonly string[];
  cohortOf: (id: string) => string | null;
  cohortLabel: string;
  nameByEntity: Map<string, string>;
  personIdByEntity: Map<string, string>;
}) {
  const flags = useMemo(
    () =>
      computeAttentionFlags({
        headlineKeys: spec.metrics,
        byKey: grid.byKey,
        previousByKey: grid.previousByKey,
        memberIds,
        cohortOf,
        nameOf: (id) => nameByEntity.get(id) ?? id,
        personIdOf: (id) => personIdByEntity.get(id) ?? id,
        cohortLabel,
      }),
    [
      spec.metrics,
      grid.byKey,
      grid.previousByKey,
      memberIds,
      cohortOf,
      cohortLabel,
      nameByEntity,
      personIdByEntity,
    ]
  );
  if (!memberIds.length) return null;
  const flaggedPeople = new Set(flags.map((f) => f.personId)).size;
  return (
    <AttentionList
      flags={flags}
      summary={attentionSummary(flags, flaggedPeople, memberIds.length)}
      max={spec.max}
    />
  );
}

function DirectionCardsSection({
  variant,
  grid,
  memberIds,
  personal,
  personalReach,
}: {
  variant: "compact" | "full";
  grid: GridData;
  memberIds: readonly string[];
  personal: boolean;
  personalReach: ReadonlySet<string> | null;
}) {
  const { t } = useTranslation();
  const { openDirection } = usePortalNavActions();
  const showPlanned = usePortalShowPlanned();
  const cards = overviewCardDirections(showPlanned)
    .map((d) => {
      const entry = lensEntry(d.id, "Overview");
      if (!entry || "comingSoon" in entry || "entity" in entry) return null;
      const gated = visibleSections(entry, showPlanned);
      const headline = gated.sections.find(
        (s): s is Extract<SectionSpec, { kind: "headline" }> =>
          s.kind === "headline"
      );
      if (!headline) return null;
      const keys =
        variant === "compact" ? headline.metrics.slice(0, 2) : headline.metrics;
      const familyKeys = sectionMetricKeys(gated);
      const connected = personal
        ? sourceConnected(familyKeys, grid.byKey, memberIds, personalReach)
        : familyObserved(grid.byKey, familyKeys, memberIds);
      const observed = familyObserved(grid.byKey, familyKeys, memberIds);
      return { id: d.id, name: d.name, keys, connected, observed };
    })
    .filter((c): c is NonNullable<typeof c> => c != null);
  if (!cards.length) return null;

  const go = (dir: string) => openDirection(dir, "Overview");

  return (
    <section className="flex flex-col gap-3">
      <p className={TEXT_EYEBROW}>
        {t("nav.items.by_direction")}
      </p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-3">
        {cards.map((c) => {
          const body = (
            <div className="flex flex-col gap-2 p-4">
              <div className="text-sm font-semibold">{resolveText(t, c.name)}</div>
              {!c.connected ? (
                <span className="text-xs text-muted-foreground">
                  {t("directions.not_connected")}
                </span>
              ) : !c.observed ? (
                <span className="text-xs text-muted-foreground">
                  nothing recorded this period
                </span>
              ) : (
                c.keys.map((key) => {
                  const r = grid.byKey.get(key);
                  if (!r) return null;
                  const reading = perPersonReading(r, memberIds);
                  if (!reading) return null;
                  const prev = perPersonReading(
                    grid.previousByKey.get(key),
                    memberIds
                  );
                  return (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <MetricName
                        metric={r}
                        text={r.label}
                        className="text-muted-foreground"
                        truncate
                      />
                      <span className="flex items-center gap-2">
                        <span className="font-medium tabular-nums">
                          {formatMetricValue(
                            reading.value,
                            r.format,
                            r.unit
                          )}
                        </span>
                        <Delta
                          now={reading.value}
                          prev={prev?.value ?? null}
                          direction={r.direction}
                        />
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          );

          return personal ? (
            <div key={c.id} className="rounded-xl border bg-card">
              {body}
            </div>
          ) : (
            <button
              key={c.id}
              type="button"
              onClick={() => go(c.id)}
              className="rounded-xl border bg-card text-left transition-colors hover:bg-card-hover"
            >
              {body}
            </button>
          );
        })}
      </div>
    </section>
  );
}

const NO_COMPARABLE_UNITS_NOTE =
  "Nothing to compare at this grouping: it needs at least two groups of four or more people, and a metric that can be added up.";

function ByUnitSection({
  config,
  grid,
  memberIds,
  keyOf,
  sliceKey,
  sliceLabel,
}: {
  config: LensConfig;
  grid: Map<string, NormalizedMetricResult>;
  memberIds: readonly string[];
  keyOf: (id: string) => string | null;
  sliceKey: string;
  sliceLabel: string;
}) {
  const planned = PLANNED_SLICES.find((d) => d.key === sliceKey);
  if (planned) {
    return (
      <SliceNote text={`Grouping by ${planned.label} is not available yet.`} />
    );
  }

  const headline = config.sections.find(
    (s): s is Extract<SectionSpec, { kind: "headline" }> =>
      s.kind === "headline"
  );
  if (!headline) return null;
  const key = headline.metrics.find((k) => grid.get(k)?.computation === "sum");
  const r = key ? grid.get(key) : undefined;
  if (!r) return <SliceNote text={NO_COMPARABLE_UNITS_NOTE} />;

  const byUnit = new Map<string, string[]>();
  for (const id of memberIds) {
    const unit = keyOf(id);
    if (!unit) continue;
    (byUnit.get(unit) ?? byUnit.set(unit, []).get(unit)!).push(id);
  }
  const bucket = new Map<string, BarEntry>();
  for (const [unit, ids] of byUnit) {
    if (ids.length < MIN_COHORT) continue;
    const v = perCapita(r, ids);
    if (v > 0) bucket.set(unit, { label: `${unit} · ${ids.length}`, value: v });
  }
  const rows = toBarRows(bucket);
  if (rows.length < 2) return <SliceNote text={NO_COMPARABLE_UNITS_NOTE} />;

  return (
    <BarList
      title={`${r.short_label ?? r.label} per active person · by ${sliceLabel}`}
      rows={rows}
      format={r.format}
      unit={r.unit}
      showShare={false}
    />
  );
}


function shareLabel(pct: number): string {
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

const BAR_LIST_COLLAPSED = 12;

function BarPiece({
  className,
  style,
  onOpen,
  label,
}: {
  className: string;
  style?: CSSProperties;
  onOpen?: () => void;
  label: string;
}) {
  if (!onOpen) return <span className={className} style={style} />;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={`Open the records behind ${label}`}
      onClick={onOpen}
      className={cn(
        className,
        "cursor-pointer transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      )}
      style={style}
    />
  );
}

export function BarList({
  title,
  rows,
  format,
  unit,
  showShare = true,
  notes,
  onOpen,
  canOpen,
}: {
  title: string;
  rows: BarRow[];
  format: NormalizedMetricResult["format"];
  unit: string | null;
  showShare?: boolean;
  notes?: readonly string[];
  onOpen?: (row: BarRow, segment?: BarSegment) => void;
  canOpen?: (row: BarRow, segment?: BarSegment) => boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rows : rows.slice(0, BAR_LIST_COLLAPSED);
  const max = rows[0]?.value || 1;
  const totals = new Map<string, { label: string; value: number }>();
  for (const row of rows) {
    for (const segment of row.segments ?? []) {
      const seen = totals.get(segment.seed);
      totals.set(segment.seed, {
        label: seen?.label ?? segment.label,
        value: (seen?.value ?? 0) + segment.value,
      });
    }
  }
  const colors = seriesColors([...totals.keys()]);
  const legend = [...totals.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .map(([seed, { label }]) => ({ seed, label, color: colors[seed] }));

  return (
    <section className="flex flex-col gap-3">
      <p className={TEXT_EYEBROW}>
        {title}
      </p>
      <Card>
        <CardContent className="flex flex-col gap-2">
          {legend.length ? (
            <ul
              className="flex flex-wrap items-center gap-x-4 gap-y-1 pb-1"
              aria-label="What each colour in a bar means"
            >
              {legend.map((entry) => (
                <li
                  key={entry.seed}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: entry.color }}
                  />
                  {entry.label}
                </li>
              ))}
            </ul>
          ) : null}
          {visible.map((row) => (
            <div key={row.key} className="flex items-center gap-3">
              <div
                className="w-44 shrink-0 truncate text-sm md:w-64 lg:w-80"
                title={row.label}
              >
                {row.href ? (
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-foreground hover:underline"
                  >
                    {row.label}
                  </a>
                ) : (
                  row.label
                )}
              </div>
              <div className="h-6 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className="flex h-full overflow-hidden rounded"
                  style={{ width: `${Math.round((row.value / max) * 100)}%` }}
                >
                  {row.segments?.length ? (
                    row.segments.map((segment) => (
                      <Tooltip key={segment.seed}>
                        <TooltipTrigger
                          render={
                            <BarPiece
                              className="h-full first:rounded-s last:rounded-e"
                              style={{
                                width: `${(segment.value / row.value) * 100}%`,
                                backgroundColor: colors[segment.seed],
                              }}
                              onOpen={
                                onOpen &&
                                (canOpen?.(row, segment) ?? true)
                                  ? () => onOpen(row, segment)
                                  : undefined
                              }
                              label={`${row.label} · ${segment.label}`}
                            />
                          }
                        />
                        <TooltipContent side="top">
                          {segment.label} ·{" "}
                          {formatMetricValue(segment.value, format, unit)} ·{" "}
                          {shareLabel((segment.value / row.value) * 100)}
                          {onOpen ? " · click to open the records" : ""}
                        </TooltipContent>
                      </Tooltip>
                    ))
                  ) : (
                    <BarPiece
                      className="h-full w-full rounded bg-primary/25"
                      onOpen={
                        onOpen && (canOpen?.(row) ?? true)
                          ? () => onOpen(row)
                          : undefined
                      }
                      label={row.label}
                    />
                  )}
                </div>
              </div>
              <div className="w-28 shrink-0 text-right text-xs font-medium text-muted-foreground tabular-nums md:w-36">
                {formatMetricValue(row.value, format, unit)}
                {showShare ? ` · ${shareLabel(row.pct)}` : ""}
              </div>
            </div>
          ))}
          {rows.length > BAR_LIST_COLLAPSED ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="self-start pt-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {expanded
                ? "Show less"
                : `+${rows.length - BAR_LIST_COLLAPSED} more`}
            </button>
          ) : null}
          {notes?.length ? (
            <div className="mt-4 flex flex-col gap-1 border-t pt-3">
              {notes.map((note) => (
                <p key={note} className="text-xs text-muted-foreground">
                  {note}
                </p>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function SliceNote({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
      {text}
    </p>
  );
}

export function Delta({
  now,
  prev,
  direction,
  showUnavailable = false,
}: {
  now: number;
  prev: number | null;
  direction: MetricDirection;
  showUnavailable?: boolean;
}) {
  if (prev == null || prev === 0) {
    return showUnavailable ? (
      <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground" title="Previous period data is unavailable or zero">
        No comparison
      </span>
    ) : null;
  }
  const diff = now - prev;
  if (Math.abs(diff) / Math.abs(prev) < 0.01) {
    return (
      <span title="Compared with previous period" className="text-xs text-muted-foreground tabular-nums">±0%</span>
    );
  }
  const up = diff > 0;
  const good =
    direction === "neutral"
      ? null
      : direction === "higher_is_better"
        ? up
        : !up;
  const color =
    good == null
      ? "text-muted-foreground"
      : good
        ? "text-success"
        : "text-destructive";
  const Icon = up ? TrendingUp : TrendingDown;
  const pct = Math.round((diff / Math.abs(prev)) * 100);
  return (
    <span
      title="Compared with previous period"
      className={`flex shrink-0 items-center gap-1 text-xs font-medium tabular-nums ${color}`}
    >
      <Icon aria-hidden className="size-3" />
      {up ? "+" : ""}
      {pct}%
    </span>
  );
}

export function Pending({ label }: { label: string }) {
  return (
    <div className="mx-auto w-full max-w-md p-8">
      <ComingSoon variant="card" state="empty" label={label} />
    </div>
  );
}
