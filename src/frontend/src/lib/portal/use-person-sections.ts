import { useTranslation } from "react-i18next";

import { resolveText } from "@/i18n/localized-text";
import { visibleGroups, type GroupId } from "@/lib/insight/groups";
import { groupHasData } from "@/lib/insight/group-data";
import { partState, reachableMetricKeys } from "@/lib/insight/coverage";
import { injectCohortPeer } from "@/lib/insight/within-team-peer";
import { countableSignals } from "@/lib/insight/metric-containment";
import {
  gradeSectionStanding,
  rankCounts,
  sectionStandingPhrase,
} from "@/lib/scoring";
import { forEntity, projectViews } from "@/lib/metrics/collection";
import { normalizePersonId } from "@/lib/metrics/entity";
import { derivePeerStanding } from "@/lib/metrics/peer-standing";
import { usePersonCohort } from "@/lib/portal/use-person-cohort";
import type { Status } from "@/lib/status";
import { usePortalPeriod } from "@/hooks/use-portal-period";
import { useNavLocation } from "@/lib/portal/use-nav-location";
import { usePortalShowPlanned } from "@/lib/portal/portal-store";
import { useMetricDefinitionsResponse } from "@/queries/metric-definitions";
import {
  useMetricCollectionSet,
  type MetricCollectionResult,
} from "@/queries/metric-results";

export interface SectionStanding {
  id: GroupId;
  title: string;
  status: Status;
  phrase: string;
  hasData: boolean;
  peersHaveData: boolean;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

const CLOSED_ENTITY = { type: "person" as const, ids: [] as string[] };

export function useSelectedPersonSection(): GroupId | null {
  const { zone, item } = useNavLocation();
  const showPlanned = usePortalShowPlanned();

  return zone === "person" && visibleGroups(showPlanned).some((def) => def.id === item)
    ? (item as GroupId)
    : null;
}

export function usePersonSectionCollection(
  personId: string
): Map<string, MetricCollectionResult> {
  const { dateRange, compareTo } = usePortalPeriod();
  const entityId = normalizePersonId(personId);
  const showPlanned = usePortalShowPlanned();
  const selectedSection = useSelectedPersonSection();

  return useMetricCollectionSet(
    visibleGroups(showPlanned).map((def) => ({
      key: def.id,
      collection: projectViews(def.collection, ["period", "peer"]),
    })),
    { type: "person" as const, ids: [entityId] },
    dateRange,
    selectedSection == null ? compareTo : undefined
  );
}

export function usePersonSectionCohort(
  personId: string
): Map<string, MetricCollectionResult> {
  const { dateRange } = usePortalPeriod();
  const cohortIds = usePersonCohort(normalizePersonId(personId));
  const showPlanned = usePortalShowPlanned();

  return useMetricCollectionSet(
    cohortIds.length
      ? visibleGroups(showPlanned).map((def) => ({
          key: def.id,
          collection: projectViews(def.collection, ["period"]),
        }))
      : [],
    cohortIds.length
      ? { type: "person" as const, ids: cohortIds }
      : CLOSED_ENTITY,
    dateRange
  );
}

export function usePersonSectionStandings(personId: string): SectionStanding[] {
  const { t } = useTranslation();
  const entityId = normalizePersonId(personId);
  const showPlanned = usePortalShowPlanned();
  const groups = visibleGroups(showPlanned);

  const groupData = usePersonSectionCollection(personId);

  const definitions = useMetricDefinitionsResponse();

  const cohortIds = usePersonCohort(entityId);
  const cohortGroup = usePersonSectionCohort(personId);

  const reachable = reachableMetricKeys(definitions.data?.metrics ?? []);

  return groups.map((def) => {
    const result = groupData.get(def.id);
    const cohort = cohortGroup.get(def.id);
    const byKey =
      result && cohortIds.length && cohort
        ? injectCohortPeer(result.byKey, cohort.byKey, cohortIds)
        : (result?.byKey ?? new Map());

    const ranks = def.collection.metrics.flatMap((m) => {
      const metric = byKey.get(m.key);
      if (!metric) return [];
      const data = forEntity(metric, entityId);
      const standing = derivePeerStanding(metric.direction, {
        value: data.value,
        absence: data.absence,
        peer:
          metric.peer?.values.find(
            (v: { entity_id: string }) => v.entity_id === entityId,
          ) ?? null,
      });
      return [{ row: m.key, rank: standing.rank }];
    });
    const counts = rankCounts(
      countableSignals(
        ranks,
        (entry) => entry.row,
        (entry) => entry.rank,
      ),
    );

    return {
      id: def.id,
      title: resolveText(t, def.title),
      status: gradeSectionStanding(counts),
      phrase: sectionStandingPhrase(counts),
      hasData: groupHasData(def, byKey, entityId),
      peersHaveData:
        partState(def, byKey, entityId, reachable) !== "no_data_reaches_us",
      isPending: definitions.isPending || (result?.isPending ?? true),
      isError: definitions.isError || (result?.isError ?? false),
      refetch: () => {
        void definitions.refetch();
        result?.refetch();
      },
    };
  });
}
