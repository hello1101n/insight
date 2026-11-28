import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

import { MetricsChangeDatePanel } from "@/components/portal/metrics-change-date-panel";
import { MetricsComparePicker } from "@/components/portal/metrics-compare-picker";
import { MetricsDownloadMenu } from "@/components/portal/metrics-download-menu";
import { MetricsTeamTimeTable } from "@/components/portal/metrics-team-time-table";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import type { MembersGridMember } from "@/components/widgets/dashboard/members-grid";
import { Button } from "@gears-frontx/ui-kit";
import {
  latestChangeDate,
  resolveChangeDate,
  type TeamTimePeriods,
  type TeamTimeWeeks,
} from "@/lib/portal/metrics-team-time";
import { keysWithData, type CompareTeam } from "@/lib/portal/metrics-view";
import { teamTimeFilename, teamTimeMatrix } from "@/lib/portal/metrics-view-export";
import { useSetPortalSearch } from "@/lib/portal/portal-search";
import type { MetricsViewData } from "@/queries/metrics-view";

import { EmptyNote } from "./empty-note";
import { LEAVE_TEAM_TIME } from "./leave-team-time";

export function TeamTimeBody({
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
