import { useEffect, useMemo, useState, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Columns3, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";

import { localToday, type DateRange } from "@/api/period-to-date-range";
import { useViewer } from "@/auth";
import { MetricsChangeDatePanel } from "@/components/portal/metrics-change-date-panel";
import { MetricsComparePicker } from "@/components/portal/metrics-compare-picker";
import { MetricsCompareTable } from "@/components/portal/metrics-compare-table";
import { MetricsDownloadMenu } from "@/components/portal/metrics-download-menu";
import {
  MetricsTable,
  type MetricsSort,
} from "@/components/portal/metrics-table";
import { MetricsTeamTimeTable } from "@/components/portal/metrics-team-time-table";
import { orgScopeGate } from "@/components/portal/org-scope-gate";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
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
import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import { normalizePersonId } from "@/lib/metrics/entity";
import { usePageTitle } from "@/lib/portal/document-title-frame";
import {
  DEFAULT_TEAM_TIME_WEEKS,
  latestChangeDate,
  resolveChangeDate,
  teamTimePeriods,
  type TeamTimePeriods,
  type TeamTimeWeeks,
} from "@/lib/portal/metrics-team-time";
import {
  compareTeams,
  rolesById,
  keysWithData,
  teamsById,
  metricGroups,
  metricsRows,
  metricsViewCatalog,
  sortRows,
  type CompareTeam,
} from "@/lib/portal/metrics-view";
import {
  metricsViewFilename,
  metricsViewMatrix,
  teamTimeFilename,
  teamTimeMatrix,
} from "@/lib/portal/metrics-view-export";
import {
  setMetricsViewPaneShown,
  useMetricsViewPaneShown,
} from "@/lib/portal/metrics-view-pane";
import { usePortalNavActions, usePortalScope } from "@/lib/portal/portal-nav";
import { usePortalSearch, useSetPortalSearch } from "@/lib/portal/portal-search";
import { usePortalShowPlanned } from "@/lib/portal/portal-store";
import { useOrgScope } from "@/lib/portal/use-org-scope";
import { useShellLayout } from "@/lib/portal/use-shell-layout";
import { byFamily } from "@/lib/reports/families";
import { useMetricDefinitionsResponse } from "@/queries/metric-definitions";
import { useMetricsViewData, type MetricsViewData } from "@/queries/metrics-view";
import type { IdentityPerson } from "@/types/insight";

const TEST_ID = "page-people-metrics";
const NO_KEYS: string[] = [];
const NO_IDS: string[] = [];
const LEAVE_TEAM_TIME = { team: undefined, change: undefined, weeks: undefined };

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
      metricsViewCatalog(definitions.data?.metrics ?? [], offeredMetricFilter(showPlanned)),
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
  const picked = useMemo(
    () =>
      metricsParam == null ? null : metricsParam === "none" ? [] : metricsParam.split(","),
    [metricsParam],
  );
  const setPicked = (next: string[] | null) =>
    setSearch(
      { metrics: next == null ? undefined : next.length === 0 ? "none" : next.join(",") },
      { replace: true },
    );
  const selected = picked ?? catalogKeys;
  const setSelected = (action: SetStateAction<string[]>) =>
    setPicked(typeof action === "function" ? action(selected) : action);
  const metricKeys = useMemo(() => {
    const chosen = new Set(selected);
    return catalogKeys.filter((key) => chosen.has(key));
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

  const data = useMetricsViewData(
    metricKeys,
    timeTeam ? timeTeam.memberIds : memberIds,
    timeTeam ? periods.after : dateRange,
  );
  const before = useMetricsViewData(
    timeTeam ? metricKeys : NO_KEYS,
    timeTeam ? timeTeam.memberIds : NO_IDS,
    periods.before,
  );
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
            after={data}
            before={before}
            periods={periods}
            change={change}
            weeks={weeks}
            today={today}
            onCompareTeam={compareTeamOverTime}
          />
        ) : (
          <MetricsBody
            key={orgScope.pivotPersonId}
            pivot={pivot}
            people={people}
            members={members}
            metricKeys={metricKeys}
            byKey={data.byKey}
            loading={data.isPending}
            range={dateRange}
            onCompareTeam={compareTeamOverTime}
          />
        ))}
    </div>
  );
}

function PaneToggle() {
  const { t } = useTranslation();
  const shown = useMetricsViewPaneShown();
  if (useShellLayout() !== "wide") return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      icon={shown ? <PanelLeftClose /> : <PanelLeftOpen />}
      onClick={() => setMetricsViewPaneShown(!shown)}
    >
      {shown ? t("metrics_view.hide_menu") : t("metrics_view.show_menu")}
    </Button>
  );
}

function ScopeChip({ label }: { label: string }) {
  const { t } = useTranslation();
  const { root } = usePortalScope();
  const { personId } = useViewer();
  const { setScope } = usePortalNavActions();

  const scopedToSomeoneElse =
    root != null &&
    normalizePersonId(root) !== normalizePersonId(personId ?? "");
  if (!scopedToSomeoneElse) return null;

  return (
    <span className="flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 ps-3 pe-1 text-sm">
      <span className="text-muted-foreground">{t("metrics_view.scoped")}</span>
      <span className="font-medium">{label}</span>
      <button
        type="button"
        aria-label={t("metrics_view.clear_scope", { label })}
        onClick={() => setScope({ root: null })}
        className="flex size-5 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

function nextSort(current: MetricsSort | null, key: string): MetricsSort | null {
  if (current?.key !== key) return { key, direction: "descending" };
  if (current.direction === "descending") return { key, direction: "ascending" };
  return null;
}

function MetricsBody({
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

  const toggle = (entityId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(entityId)) next.add(entityId);
      return next;
    });

  const rows = sort
    ? sortRows(metricsRows(null, people, expanded), sort.key, sort.direction, byKey)
    : metricsRows(pivot, people, expanded);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {comparing
            ? comparingNote(t, compared)
            : t("metrics_view.people_count", { count: inView.length })}
        </p>
        {allManagers.length > 0 && !sort && !comparing ? (
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
          sort={sort}
          onSort={(key) => setSort((current) => nextSort(current, key))}
          onToggle={toggle}
          onScope={(entityId) => setScope({ root: entityId })}
        />
      )}
    </section>
  );
}

function TeamTimeBody({
  team,
  members,
  teams,
  metricKeys,
  after,
  before,
  periods,
  change,
  weeks,
  today,
  onCompareTeam,
}: {
  team: CompareTeam;
  members: readonly MembersGridMember[];
  teams: readonly CompareTeam[];
  metricKeys: readonly string[];
  after: MetricsViewData;
  before: MetricsViewData;
  periods: TeamTimePeriods;
  change: string;
  weeks: TeamTimeWeeks;
  today: Date;
  onCompareTeam: (teamId: string) => void;
}) {
  const { t } = useTranslation();
  const setSearch = useSetPortalSearch();
  const loading = after.isPending || before.isPending;
  const withData = new Set([
    ...keysWithData(metricKeys, after.byKey, team.memberIds),
    ...keysWithData(metricKeys, before.byKey, team.memberIds),
  ]);
  const keys = metricKeys.filter((key) => withData.has(key));
  const view = { keys, after: after.byKey, before: before.byKey, memberIds: team.memberIds, periods };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <MetricsComparePicker
          people={members}
          teams={teams}
          picked={[]}
          onCompare={(ids) => setSearch({ ...LEAVE_TEAM_TIME, compare: ids.join(",") })}
          team={team.id}
          onCompareTeam={onCompareTeam}
          align="start"
        />
        <p className="text-sm">
          {t("metrics_view.team_roster", {
            team: t("people.team_possessive", { name: team.name }),
            count: team.memberIds.length,
          })}
        </p>
        <div className="ms-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<X />}
            onClick={() => setSearch(LEAVE_TEAM_TIME)}
          >
            {t("metrics_view.exit_compare")}
          </Button>
          <MetricsDownloadMenu
            matrix={() => teamTimeMatrix(view)}
            filename={(extension) => teamTimeFilename(periods, extension)}
            disabled={metricKeys.length === 0 || loading}
          />
        </div>
      </div>
      <div className="flex flex-col items-start gap-3 lg:flex-row">
        <div className="w-full min-w-0 flex-1">
          {metricKeys.length === 0 ? (
            <EmptyNote text={t("metrics_view.no_metrics")} />
          ) : loading ? (
            <CenteredSpinner className="min-h-[40vh]" />
          ) : (
            <MetricsTeamTimeTable {...view} />
          )}
        </div>
        <div className="w-full shrink-0 lg:w-80">
          <MetricsChangeDatePanel
            change={change}
            weeks={weeks}
            latest={latestChangeDate(weeks, today)}
            onChange={(next) => setSearch({ change: next }, { replace: true })}
            onWeeks={(next) =>
              setSearch(
                { weeks: next, change: resolveChangeDate(change, next, today) },
                { replace: true },
              )
            }
          />
        </div>
      </div>
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

function EmptyNote({ text }: { text: string }) {
  return (
    <p className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
      {text}
    </p>
  );
}
