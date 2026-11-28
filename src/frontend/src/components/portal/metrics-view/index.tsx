import { useEffect, useMemo, useState, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Columns3 } from "lucide-react";

import { localToday } from "@/api/period-to-date-range";
import { orgScopeGate } from "@/components/portal/org-scope-gate";
import {
  ReportMetricPicker,
  type OfferedReportMetric,
} from "@/components/portal/report-builder-metrics";
import type { MembersGridMember } from "@/components/widgets/dashboard/members-grid";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@gears-frontx/ui-kit";
import { usePortalPeriod } from "@/hooks/use-portal-period";
import { personDisplayName } from "@/lib/identities/person-display";
import { offeredMetricFilter } from "@/lib/insight/groups";
import { flattenSubordinates } from "@/lib/insight/identity-tree";
import { normalizePersonId } from "@/lib/metrics/entity";
import { usePageTitle } from "@/lib/portal/document-title-frame";
import {
  DEFAULT_TEAM_TIME_WEEKS,
  resolveChangeDate,
  teamTimePeriods,
} from "@/lib/portal/metrics-team-time";
import {
  compareTeams,
  defaultMetricKeys,
  defaultMetricOrder,
  metricsViewCatalog,
  orderMetricKeys,
} from "@/lib/portal/metrics-view";
import {
  requestedMetricKeys,
  withCombinedColumns,
  withCombinedResults,
} from "@/lib/portal/metrics-view-combined";
import { readStoredMetricsPick, storeMetricsPick } from "@/lib/portal/metrics-view-pick";
import { usePortalSearch, useSetPortalSearch } from "@/lib/portal/portal-search";
import { usePortalShowPlanned } from "@/lib/portal/portal-store";
import { useOrgScope } from "@/lib/portal/use-org-scope";
import { byFamily } from "@/lib/reports/families";
import { useMetricDefinitionsResponse } from "@/queries/metric-definitions";
import { useMetricsViewData } from "@/queries/metrics-view";

import { LEAVE_TEAM_TIME } from "./leave-team-time";
import { PaneToggle } from "./pane-toggle";
import { PeopleBody } from "./people-body";
import { ScopeChip } from "./scope-chip";
import { TeamTimeBody } from "./team-time-body";

const TEST_ID = "page-people-metrics";
const NO_KEYS: string[] = [];
const NO_IDS: string[] = [];

function comparedNames(
  compareParam: string,
  members: readonly MembersGridMember[],
): string[] {
  const byId = new Map(
    members.map((member) => [member.entityId, member.displayName]),
  );
  const names: string[] = [];
  for (const id of compareParam.split(",")) {
    const name = byId.get(id);
    if (name) names.push(name);
  }
  return names;
}

export function MetricsView() {
  const { t } = useTranslation();
  const { dateRange } = usePortalPeriod();
  const orgScope = useOrgScope();
  const definitions = useMetricDefinitionsResponse();
  const showPlanned = usePortalShowPlanned();

  const catalog = useMemo(
    () =>
      withCombinedColumns(
        metricsViewCatalog(definitions.data?.metrics ?? [], offeredMetricFilter(showPlanned)),
      ),
    [definitions.data, showPlanned],
  );
  const catalogKeys = useMemo(
    () => catalog.map((metric) => metric.metric_key),
    [catalog],
  );
  const families = useMemo(
    () =>
      byFamily<OfferedReportMetric>(
        catalog.map((metric) => ({ ...metric, reason: null })),
      ),
    [catalog],
  );

  const {
    metrics: metricsParam,
    compare: compareParam,
    team: teamParam,
    change: changeParam,
    weeks: weeksParam,
  } = usePortalSearch();
  const setSearch = useSetPortalSearch();
  const [storedPick, setStoredPick] = useState(readStoredMetricsPick);
  if (metricsParam != null && metricsParam !== storedPick) setStoredPick(metricsParam);
  const pickParam = metricsParam ?? storedPick;
  const picked = useMemo(
    () => (pickParam == null ? null : pickParam === "none" ? [] : pickParam.split(",")),
    [pickParam],
  );
  useEffect(() => {
    if (metricsParam != null) storeMetricsPick(metricsParam);
  }, [metricsParam]);
  const setPicked = (next: string[] | null) => {
    const value = next == null ? null : next.length === 0 ? "none" : next.join(",");
    setSearch({ metrics: value ?? undefined }, { replace: true });
    storeMetricsPick(value);
    setStoredPick(value);
  };
  const defaultKeys = useMemo(() => defaultMetricKeys(catalogKeys), [catalogKeys]);
  const selected = picked ?? defaultKeys;
  const setSelected = (action: SetStateAction<string[]>) =>
    setPicked(typeof action === "function" ? action(selected) : action);
  const metricKeys = useMemo(() => {
    const chosen = new Set(selected);
    return orderMetricKeys(
      catalogKeys.filter((key) => chosen.has(key)),
      defaultMetricOrder(),
    );
  }, [catalogKeys, selected]);

  const { pivot, roster } = orgScope;
  const people = useMemo(
    () => (pivot ? [pivot, ...flattenSubordinates(pivot)] : (roster ?? [])),
    [pivot, roster],
  );
  const members = useMemo<MembersGridMember[]>(
    () =>
      people.map((person) => ({
        entityId: normalizePersonId(person.person_id),
        displayName: personDisplayName(person),
      })),
    [people],
  );
  const memberIds = useMemo(
    () => members.map((member) => member.entityId),
    [members],
  );
  const compared = compareParam
    ? comparedNames(compareParam, members)
    : [];

  const teams = useMemo(() => compareTeams(pivot), [pivot]);
  const timeTeam = teamParam ? (teams.find((team) => team.id === teamParam) ?? null) : null;
  const treeLoaded = !orgScope.isLoading && !orgScope.isError;
  const teamOutOfScope = treeLoaded && teamParam != null && timeTeam == null;
  useEffect(() => {
    if (teamOutOfScope) setSearch(LEAVE_TEAM_TIME, { replace: true });
  }, [teamOutOfScope, setSearch]);

  const weeks = weeksParam ?? DEFAULT_TEAM_TIME_WEEKS;
  const today = localToday();
  const change = resolveChangeDate(changeParam, weeks, today);
  const periods = useMemo(() => teamTimePeriods(change, weeks), [change, weeks]);
  usePageTitle(
    timeTeam
      ? t("people.team_possessive", { name: timeTeam.name })
      : compared.length > 0
        ? compared.join(", ")
        : null,
  );

  const requestKeys = useMemo(() => requestedMetricKeys(metricKeys), [metricKeys]);
  const data = useMetricsViewData(
    requestKeys,
    timeTeam ? timeTeam.memberIds : memberIds,
    timeTeam ? periods.after : dateRange,
  );
  const before = useMetricsViewData(
    timeTeam ? requestKeys : NO_KEYS,
    timeTeam ? timeTeam.memberIds : NO_IDS,
    periods.before,
  );
  const byKey = useMemo(() => withCombinedResults(data.byKey), [data.byKey]);
  const beforeByKey = useMemo(() => withCombinedResults(before.byKey), [before.byKey]);
  const compareTeamOverTime = (teamId: string) =>
    setSearch({ compare: undefined, team: teamId, change, weeks });

  const gate = orgScopeGate({
    "data-testid": TEST_ID,
    viewerLoading: orgScope.isLoading,
    viewerError: orgScope.isError,
    membersLoading: false,
    membersError: false,
    memberCount: members.length,
    gridPending: definitions.isPending,
    gridError: definitions.isError || data.isError || before.isError,
    emptyLabel: t("metrics_view.no_people"),
    onRetry: () => {
      orgScope.refetch();
      void definitions.refetch();
      data.refetch();
      before.refetch();
    },
  });

  return (
    <div data-testid={TEST_ID} className="flex flex-col gap-3 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <PaneToggle />
        <h1 className="text-lg font-semibold tracking-tight">{t("metrics_view.title")}</h1>
        <ScopeChip label={orgScope.label} />
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="sm"
                icon={<Columns3 />}
                className="ms-auto"
              >
                {t("metrics_view.count", {
                  picked: metricKeys.length,
                  total: catalogKeys.length,
                })}
              </Button>
            }
          />
          <PopoverContent
            align="end"
            className="max-h-[70svh] w-[min(56rem,90vw)] overflow-y-auto"
          >
            <div className="flex items-center gap-2 border-b px-4 py-2">
              <span className="me-auto text-sm text-muted-foreground tabular-nums">
                {t("metrics_view.selected_count", { count: metricKeys.length })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPicked(null)}
              >
                {t("metrics_view.reset_to_defaults")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t("metrics_view.select_all_metrics")}
                onClick={() => setPicked(catalogKeys)}
              >
                {t("metrics_view.select_all")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={t("metrics_view.clear_all_metrics")}
                onClick={() => setPicked([])}
              >
                {t("metrics_view.clear_all")}
              </Button>
            </div>
            <ReportMetricPicker
              families={families}
              selected={selected}
              setSelected={setSelected}
            />
          </PopoverContent>
        </Popover>
      </div>
      {gate ??
        (timeTeam ? (
          <TeamTimeBody
            team={timeTeam}
            members={members}
            teams={teams}
            metricKeys={metricKeys}
            after={{ ...data, byKey }}
            before={{ ...before, byKey: beforeByKey }}
            periods={periods}
            change={change}
            weeks={weeks}
            today={today}
            onCompareTeam={compareTeamOverTime}
          />
        ) : (
          <PeopleBody
            key={orgScope.pivotPersonId}
            pivot={pivot}
            people={people}
            members={members}
            metricKeys={metricKeys}
            byKey={byKey}
            loading={data.isPending}
            range={dateRange}
            onCompareTeam={compareTeamOverTime}
          />
        ))}
    </div>
  );
}
