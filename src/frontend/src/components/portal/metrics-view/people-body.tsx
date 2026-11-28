import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { X } from "lucide-react";

import type { DateRange } from "@/api/period-to-date-range";
import { MetricsComparePicker } from "@/components/portal/metrics-compare-picker";
import { MetricsCompareTable } from "@/components/portal/metrics-compare-table";
import { MetricsDownloadMenu } from "@/components/portal/metrics-download-menu";
import {
  MetricsTable,
  type MetricsSort,
} from "@/components/portal/metrics-table";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import type { MembersGridMember } from "@/components/widgets/dashboard/members-grid";
import { Button } from "@gears-frontx/ui-kit";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import { normalizePersonId } from "@/lib/metrics/entity";
import {
  compareTeams,
  rolesById,
  keysWithData,
  teamsById,
  metricGroups,
  metricsRows,
  sortRows,
} from "@/lib/portal/metrics-view";
import {
  metricsViewFilename,
  metricsViewMatrix,
} from "@/lib/portal/metrics-view-export";
import { usePortalNavActions } from "@/lib/portal/portal-nav";
import { usePortalSearch, useSetPortalSearch } from "@/lib/portal/portal-search";
import type { IdentityPerson } from "@/types/insight";

import { EmptyNote } from "./empty-note";
import { LEAVE_TEAM_TIME } from "./leave-team-time";

function nextSort(current: MetricsSort | null, key: string): MetricsSort | null {
  if (current?.key !== key) return { key, direction: "descending" };
  if (current.direction === "descending") return { key, direction: "ascending" };
  return null;
}

export function PeopleBody({
  pivot,
  people,
  members,
  metricKeys,
  byKey,
  loading,
  range,
  onCompareTeam,
}: {
  pivot: IdentityPerson | null;
  people: ReadonlyArray<{ person_id: string; display_name?: string | null }>;
  members: MembersGridMember[];
  metricKeys: readonly string[];
  byKey: Map<string, NormalizedMetricResult>;
  loading: boolean;
  range: DateRange;
  onCompareTeam: (teamId: string) => void;
}) {
  const { t } = useTranslation();
  const { setScope } = usePortalNavActions();
  const { compare: compareParam } = usePortalSearch();
  const setSearch = useSetPortalSearch();
  const comparing = compareParam ? compareParam.split(",") : null;
  const setComparing = (ids: string[] | null) =>
    setSearch({ ...LEAVE_TEAM_TIME, compare: ids?.length ? ids.join(",") : undefined });
  const [sort, setSort] = useState<MetricsSort | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(pivot ? [normalizePersonId(pivot.person_id)] : []),
  );
  const teams = compareTeams(pivot);
  const roles = rolesById(pivot);
  const personTeams = teamsById(pivot);
  const allManagers = teams.map((team) => team.id);
  const allExpanded = allManagers.every((id) => expanded.has(id));

  const byId = new Map(members.map((member) => [member.entityId, member]));
  const compared = (comparing ?? []).flatMap((id) => {
    const member = byId.get(id);
    return member ? [member] : [];
  });
  const inView = comparing ? compared : members;
  const inViewIds = inView.map((member) => member.entityId);
  const columns = keysWithData(metricKeys, byKey, inViewIds);
  const shownSort = sort && columns.includes(sort.key) ? sort : null;

  const toggle = (entityId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(entityId)) next.add(entityId);
      return next;
    });

  const rows = shownSort
    ? sortRows(metricsRows(null, people, expanded), shownSort.key, shownSort.direction, byKey)
    : metricsRows(pivot, people, expanded);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {comparing
            ? comparingNote(t, compared)
            : t("metrics_view.people_count", { count: inView.length })}
        </p>
        {allManagers.length > 0 && !shownSort && !comparing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(new Set(allExpanded ? [] : allManagers))}
          >
            {allExpanded ? t("metrics_view.collapse_all") : t("metrics_view.expand_all")}
          </Button>
        ) : null}
        <div className="ms-auto flex items-center gap-2">
          {comparing ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<X />}
              onClick={() => setComparing(null)}
            >
              {t("metrics_view.exit_compare")}
            </Button>
          ) : null}
          <MetricsComparePicker
            people={members}
            teams={teams}
            picked={comparing ?? []}
            onCompare={setComparing}
            onCompareTeam={onCompareTeam}
          />
          <MetricsDownloadMenu
            matrix={() =>
              metricsViewMatrix({
                people: comparing ? compared : rows,
                keys: columns,
                byKey,
                roles,
                range,
              })
            }
            filename={(extension) => metricsViewFilename(range, extension)}
            disabled={metricKeys.length === 0 || loading}
          />
        </div>
      </div>
      {metricKeys.length === 0 ? (
        <EmptyNote text={t("metrics_view.no_metrics")} />
      ) : loading ? (
        <CenteredSpinner className="min-h-[40vh]" />
      ) : comparing ? (
        <MetricsCompareTable
          people={compared}
          keys={columns}
          byKey={byKey}
          roles={roles}
          teams={personTeams}
        />
      ) : (
        <MetricsTable
          rows={rows}
          groups={metricGroups(columns)}
          byKey={byKey}
          roles={roles}
          sort={shownSort}
          onSort={(key) => setSort((current) => nextSort(current, key))}
          onToggle={toggle}
          onScope={(entityId) => setScope({ root: entityId })}
        />
      )}
    </section>
  );
}

function comparingNote(t: TFunction, compared: readonly MembersGridMember[]): string {
  const [first, second] = compared;
  if (compared.length === 2 && first && second) {
    return t("metrics_view.comparing_two", { first: first.displayName, second: second.displayName });
  }
  if (compared.length >= 3) return t("metrics_view.comparing_median", { count: compared.length });
  return t("metrics_view.comparing", { count: compared.length });
}
