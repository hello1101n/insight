import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useViewer } from "@/auth";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { GroupDrilldownSheet } from "@/components/widgets/dashboard/group-drilldown-sheet";
import { IcNeedsAttention } from "@/components/widgets/dashboard/ic-needs-attention";
import { PersonCoverage } from "@/components/widgets/dashboard/person-coverage";
import { KpiTile } from "@/components/widgets/dashboard/kpi-tile";
import { usePortalPeriod } from "@/hooks/use-portal-period";
import {
  metricAttentionItems,
  orderAttentionItems,
} from "@/lib/insight/attention";
import { typicalPeerPool } from "@/lib/insight/peer-pool";
import {
  KPI_ROW,
  KPI_ROW_COLLECTION,
  GROUPS,
  type GroupId,
} from "@/lib/insight/groups";
import { metricKpiTiles } from "@/lib/insight/kpi-row";
import { injectCohortPeer } from "@/lib/insight/within-team-peer";
import type { MetricCollectionConfig } from "@/lib/metrics/collection";
import { normalizePersonId } from "@/lib/metrics/entity";
import { TEXT_EYEBROW } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { useCohortLabel } from "@/lib/portal/use-cohort-label";
import { usePersonCohort } from "@/lib/portal/use-person-cohort";
import {
  personTrendPoints,
  runningBucketStart,
  TREND_BUCKETS,
  trendBucket,
  trendRange,
} from "@/lib/portal/person-trend";
import {
  usePersonSectionCohort,
  usePersonSectionCollection,
  usePersonSectionStandings,
} from "@/lib/portal/use-person-sections";
import {
  collectionSetPending,
  useMetricCollection,
} from "@/queries/metric-results";

const EMPTY_COLLECTION: MetricCollectionConfig = { metrics: [] };

// WORKAROUND: Tailwind's scanner reads source text, so every class name is spelled out whole.
const TILE_GRID: Record<number, string> = {
  0: "grid-cols-1",
  1: "grid-cols-1",
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
};

const CLOSED_ENTITY = { type: "person" as const, ids: [] };
const CLOSED_DRILLDOWN_DATA = {
  byKey: new Map(),
  previousByKey: null,
  isPending: true,
  isFetching: false,
  isError: false,
  refetch: () => {},
} as const;

export interface MetricGroupsViewProps {
  "data-testid"?: string;
  personId: string;
  groupIds: readonly GroupId[];
  content?: MetricGroupsContent;
  onSelectGroup?: (id: GroupId) => void;
  embedded?: boolean;
}

export type MetricGroupsContent = "glance" | "attention" | "none";

export function MetricGroupsView({
  "data-testid": testId,
  personId,
  groupIds,
  content = "none",
  onSelectGroup,
  embedded = false,
}: MetricGroupsViewProps) {
  const { t } = useTranslation();
  const showKpis = content === "glance";
  const showAttention = content !== "none";
  const cohortLabel = useCohortLabel();
  const { period, dateRange, compareTo, comparisonNoun } = usePortalPeriod();
  const entityId = normalizePersonId(personId);
  const { personId: viewerPersonId } = useViewer();
  const isSelf = normalizePersonId(viewerPersonId ?? "") === entityId;
  const entity = { type: "person" as const, ids: [entityId] };

  const defs = GROUPS.filter((d) => groupIds.includes(d.id));

  const kpiData = useMetricCollection(
    showKpis ? KPI_ROW_COLLECTION : EMPTY_COLLECTION,
    showKpis ? entity : CLOSED_ENTITY,
    dateRange,
    { compareTo }
  );
  const groupData = usePersonSectionCollection(personId);

  const cohortIds = usePersonCohort(entityId);
  const cohortEntity = cohortIds.length
    ? { type: "person" as const, ids: cohortIds }
    : CLOSED_ENTITY;
  const cohortKpi = useMetricCollection(
    cohortIds.length && showKpis ? KPI_ROW_COLLECTION : EMPTY_COLLECTION,
    cohortIds.length && showKpis ? cohortEntity : CLOSED_ENTITY,
    dateRange
  );
  const cohortGroup = usePersonSectionCohort(personId);

  const sectionStandings = usePersonSectionStandings(personId);

  const bucket = trendBucket(period);
  const trendCollection = useMemo(
    () => ({
      metrics: KPI_ROW.map((key) => ({
        key,
        views: [{ view: "timeseries" as const, bucket }],
      })),
    }),
    [bucket]
  );
  const trendData = useMetricCollection(
    showKpis ? trendCollection : EMPTY_COLLECTION,
    showKpis ? entity : CLOSED_ENTITY,
    trendRange(dateRange.to, bucket)
  );

  const [openGroup, setOpenGroup] = useState<GroupId | null>(null);
  const openOrSelect = onSelectGroup ?? setOpenGroup;
  const openDef =
    openGroup != null ? (defs.find((d) => d.id === openGroup) ?? null) : null;
  const drilldownData = useMetricCollection(
    openDef?.collection ?? EMPTY_COLLECTION,
    openDef ? entity : CLOSED_ENTITY,
    dateRange
  );

  const [prevPersonId, setPrevPersonId] = useState(personId);
  if (personId !== prevPersonId) {
    setPrevPersonId(personId);
    setOpenGroup(null);
  }

  if (defs.length === 0) {
    return (
      <div className="mx-auto w-full max-w-md p-8">
        <ComingSoon
          variant="card"
          state="empty"
          label="Not available yet for this direction"
        />
      </div>
    );
  }

  const cohortPending =
    cohortIds.length > 0 &&
    ((showKpis && cohortKpi.isPending) || collectionSetPending(cohortGroup));
  const isLoading =
    (showKpis && kpiData.isPending) ||
    collectionSetPending(groupData) ||
    cohortPending;
  if (isLoading) {
    return <CenteredSpinner data-testid={testId} className={embedded ? "min-h-40" : "min-h-[60vh]"} />;
  }

  const isError =
    (showKpis && kpiData.isError) ||
    [...groupData.values()].some((r) => r.isError) ||
    (cohortIds.length > 0 &&
      ((showKpis && cohortKpi.isError) ||
        [...cohortGroup.values()].some((r) => r.isError)));
  if (isError)
    return (
      <div data-testid={testId} className="mx-auto w-full max-w-md p-8">
        <ComingSoon
          variant="card"
          state="error"
          onRetry={() => {
            kpiData.refetch();
            groupData.forEach((r) => r.refetch());
            cohortKpi.refetch();
            cohortGroup.forEach((r) => r.refetch());
          }}
        />
      </div>
    );

  const kpiByKey = injectCohortPeer(kpiData.byKey, cohortKpi.byKey, cohortIds);
  const groupResult = (id: GroupId) => {
    const r = groupData.get(id);
    if (!r) return undefined;
    const cr = cohortGroup.get(id);
    if (!cohortIds.length || !cr) return r;
    return { ...r, byKey: injectCohortPeer(r.byKey, cr.byKey, cohortIds) };
  };

  const peerPool = showKpis ? typicalPeerPool(kpiByKey, entityId) : null;

  const tiles = showKpis
    ? metricKpiTiles(kpiByKey, kpiData.previousByKey, entityId)
    : [];

  const headlineKeys = new Set(tiles.map((t) => t.key));

  const blank = showKpis
    ? sectionStandings.filter((st) => !st.isPending && !st.hasData)
    : [];
  const unmeasured = blank.filter((st) => !st.peersHaveData).map((st) => st.title);
  const inactive = blank.filter((st) => st.peersHaveData).map((st) => st.title);

  const attentionItems = showAttention
    ? orderAttentionItems(
        defs.flatMap((def) =>
          metricAttentionItems(
            def,
            groupResult(def.id)?.byKey ?? new Map(),
            groupData.get(def.id)?.previousByKey ?? null,
            entityId,
            headlineKeys
          )
        ),
        headlineKeys,
        isSelf
      )
    : [];

  const Shell = embedded ? "div" : "main";

  return (
    <>
      <Shell
        data-testid={testId}
        className={cn(
          "flex flex-1 flex-col gap-8",
          !embedded && "p-4 md:p-6"
        )}
      >
        {content === "attention" ? (
          attentionItems.length > 0 ? (
            <IcNeedsAttention
              items={attentionItems}
              onOpenGroup={openOrSelect}
              titled={false}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("worth_a_look.nothing_stands_out")}
            </p>
          )
        ) : null}
        {showKpis ? (
          <>
            <PersonCoverage unmeasured={unmeasured} inactive={inactive} />
            <section className="flex flex-col gap-3">
              <p className={cn("flex flex-wrap items-baseline gap-x-2", TEXT_EYEBROW)}>
                At a glance
                {peerPool ? (
                  <span className="font-normal tracking-normal normal-case">
                    · compared with {peerPool} people in the same {cohortLabel}
                  </span>
                ) : null}
                <span className="font-normal tracking-normal normal-case">
                  · lines cover the last {TREND_BUCKETS}{" "}
                  {bucket === "week" ? "weeks" : "months"}
                </span>
              </p>
              <div
                className={cn(
                  "grid gap-3",
                  TILE_GRID[tiles.length] ?? TILE_GRID[4]
                )}
              >
                {tiles.map((tile) => (
                  <KpiTile
                    key={tile.key}
                    tile={tile}
                    periodNoun={comparisonNoun}
                    trend={personTrendPoints(
                      trendData.byKey.get(tile.key),
                      entityId,
                      runningBucketStart(dateRange.to, bucket)
                    )}
                    onOpenGroup={openOrSelect}
                  />
                ))}
              </div>
            </section>
            <IcNeedsAttention
              items={attentionItems}
              onOpenGroup={openOrSelect}
            />
          </>
        ) : null}
      </Shell>

      {onSelectGroup
        ? null
        : defs.map((def) => (
            <GroupDrilldownSheet
              key={def.id}
              open={openGroup === def.id}
              onOpenChange={(o) => setOpenGroup(o ? def.id : null)}
              def={def}
              metricTarget={{
                kind: "person",
                entityId,
                data:
                  def.id === openGroup ? drilldownData : CLOSED_DRILLDOWN_DATA,
              }}
              range={dateRange}
              compareTo={compareTo}
              cohortLabel={cohortLabel}
            />
          ))}
    </>
  );
}
