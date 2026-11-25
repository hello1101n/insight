import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { resolveText } from "@/i18n/localized-text";

import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { CollectionDrilldown } from "@/components/widgets/metric-views/collection-drilldown";
import { MetricActivity } from "@/components/widgets/metric-views/metric-activity";
import { SectionMetricIndex } from "@/components/widgets/metric-views/section-metric-index";
import { usePortalPeriod } from "@/hooks/use-portal-period";
import {
  everObservedMetricKeys,
  partState,
  type PartState,
} from "@/lib/insight/coverage";
import { GROUPS, type GroupId } from "@/lib/insight/groups";
import { finestGrain } from "@/lib/insight/metric-grain";
import { sectionSources } from "@/lib/insight/section-sources";
import { injectCohortPeer } from "@/lib/insight/within-team-peer";
import {
  forEntity,
  type MetricCollectionConfig,
} from "@/lib/metrics/collection";
import { normalizePersonId } from "@/lib/metrics/entity";
import { usePersonCohort } from "@/lib/portal/use-person-cohort";
import { useMetricDefinitionsResponse } from "@/queries/metric-definitions";
import { useMetricCollection } from "@/queries/metric-results";
import { TEXT_TITLE } from "@/lib/type-scale";

const EMPTY_COLLECTION: MetricCollectionConfig = { metrics: [] };
const CLOSED_ENTITY = { type: "person" as const, ids: [] };

type Emptiness = "unverified" | Exclude<PartState, "reads">;

const EMPTINESS_TEXT_KEY: Record<Emptiness, string> = {
  unverified: "people.section.nothing_for_period",
  nothing_recorded: "people.section.nothing_recorded",
  no_data_reaches_us: "people.section.no_source",
};

export function SingleGroupView({
  personId,
  groupId,
  "data-testid": testId,
}: {
  "data-testid"?: string;
  personId: string;
  groupId: GroupId;
}) {
  const { t } = useTranslation();
  const { dateRange, compareTo, comparisonNoun } = usePortalPeriod();
  const entityId = normalizePersonId(personId);
  const def = GROUPS.find((d) => d.id === groupId) ?? null;

  const data = useMetricCollection(
    def?.collection ?? EMPTY_COLLECTION,
    def ? { type: "person", ids: [entityId] } : CLOSED_ENTITY,
    dateRange,
    { compareTo },
  );
  const definitions = useMetricDefinitionsResponse();
  const cohortIds = usePersonCohort(entityId);
  const cohortData = useMetricCollection(
    def && cohortIds.length ? def.collection : EMPTY_COLLECTION,
    cohortIds.length ? { type: "person", ids: cohortIds } : CLOSED_ENTITY,
    dateRange,
  );
  const injectedData = useMemo(
    () => ({
      ...data,
      byKey: injectCohortPeer(data.byKey, cohortData.byKey, cohortIds),
    }),
    [data, cohortData.byKey, cohortIds],
  );

  const charted = new Set(
    (def?.drilldown ?? []).flatMap((block) =>
      block.view === "timeseries" ? block.metrics : [],
    ),
  );
  const composed = new Set(
    (def?.drilldown ?? []).flatMap((block) => block.metrics),
  );

  const headline = (def?.card.preview ?? []).flatMap((key) => {
    const metric = injectedData.byKey.get(key);
    if (!metric) return [];
    const grain = finestGrain(metric);
    if (grain == null) return [metric];
    if (grain !== "event" && charted.has(key)) return [];
    return [metric];
  });

  if (!def) {
    return (
      <div className="mx-auto w-full max-w-md p-8">
        <ComingSoon variant="card" state="empty" label="Unknown group" />
      </div>
    );
  }
  if (data.isPending || definitions.isPending)
    return <CenteredSpinner data-testid={testId} className="min-h-[60vh]" />;
  if (data.isError) {
    return (
      <div data-testid={testId} className="mx-auto w-full max-w-md p-8">
        <ComingSoon variant="card" state="error" onRetry={() => data.refetch()} />
      </div>
    );
  }

  const state = partState(
    def,
    injectedData.byKey,
    entityId,
    everObservedMetricKeys(definitions.data?.metrics ?? []),
  );
  if (state !== "reads") {
    const emptiness: Emptiness = definitions.isError ? "unverified" : state;
    return (
      <div data-testid={testId} className="flex flex-col gap-3 p-4 md:p-6">
        <h1 className={TEXT_TITLE}>{resolveText(t, def.title)}</h1>
        <p className="text-sm text-muted-foreground">
          {t(EMPTINESS_TEXT_KEY[emptiness])}
        </p>
      </div>
    );
  }

  const sources = sectionSources(def, injectedData.byKey, entityId);
  const readable = headline.filter((metric) => finestGrain(metric) != null);
  const observed = headline.filter(
    (metric) => forEntity(metric, entityId).value != null,
  );

  return (
    <div data-testid={testId} className="flex flex-col gap-4 p-4 md:p-6">
      <h1 className={TEXT_TITLE}>{resolveText(t, def.title)}</h1>
      {sources.length > 0 ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          From {sources.join(", ")}
        </p>
      ) : null}
      <CollectionDrilldown
        def={def}
        data={injectedData}
        entityId={entityId}
        range={dateRange}
      >
        {headline.length > 0 ? (
          <div className="rounded-xl border p-4 sm:p-5">
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              The work behind these numbers
            </h2>
            {observed.length === 0 ? (
              <p className="pt-2 text-xs text-muted-foreground">
                Nothing recorded in this section for the selected period.
              </p>
            ) : readable.length === 0 ? (
              <p className="pt-2 text-xs text-muted-foreground">
                These metrics report period totals only — nothing here can be
                broken down by day or by item yet.
              </p>
            ) : (
              observed.map((metric) => (
                <MetricActivity
                  key={metric.metric_key}
                  metric={metric}
                  previous={
                    injectedData.previousByKey?.get(metric.metric_key) ?? null
                  }
                  entityId={entityId}
                  periodNoun={comparisonNoun}
                />
              ))
            )}
          </div>
        ) : null}
        <SectionMetricIndex
          collection={def.collection}
          byKey={injectedData.byKey}
          entityId={entityId}
          shown={new Set([...composed, ...observed.map((m) => m.metric_key)])}
        />
      </CollectionDrilldown>
    </div>
  );
}
