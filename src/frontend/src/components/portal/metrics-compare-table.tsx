import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { MetricValue } from "@/components/portal/metrics-table";
import type { MembersGridMember } from "@/components/widgets/dashboard/members-grid";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import {
  compareWithBest,
  compareWithMedian,
  formatDelta,
  groupByTeam,
  sharedTeam,
} from "@/lib/portal/metrics-compare";
import {
  directionNote,
  finiteValue,
  formatViewValue,
  type PersonTeam,
} from "@/lib/portal/metrics-view";
import { cn } from "@/lib/utils";

const STICKY_START = "sticky start-0 z-10";
const HEAD_CELL = "sticky z-10 border-b bg-muted px-3 py-2 text-start align-top font-medium";
const TEAM_ROW_CELL = "sticky top-0 z-10 h-8 border-b bg-muted";
const BODY_CELL = "border-b px-3 py-2 text-start whitespace-nowrap tabular-nums";
const MUTED_LINE = "block text-xs font-normal text-muted-foreground";
const MUTED_NOTE = "text-xs text-muted-foreground";
const SIDE_BY_SIDE = "inline-flex items-baseline gap-1.5";

type Person = MembersGridMember;

export function MetricsCompareTable({
  people,
  keys,
  byKey,
  roles,
  teams,
}: {
  people: readonly Person[];
  keys: readonly string[];
  byKey: ReadonlyMap<string, NormalizedMetricResult>;
  roles: ReadonlyMap<string, string>;
  teams: ReadonlyMap<string, PersonTeam>;
}) {
  const { t } = useTranslation();
  const byMedian = people.length >= 3;
  const shared = sharedTeam(
    people.map((person) => person.entityId),
    teams,
  );
  const groups = byMedian && !shared ? groupByTeam(people, teams) : [];
  const grouped = groups.length >= 2;
  const columns = grouped ? groups.flatMap((group) => group.members) : people;
  const headTop = grouped ? "top-8" : "top-0";
  const teamName = (team: PersonTeam) => t("people.team_possessive", { name: team.name });

  const headerNote = (person: Person) => {
    const team = byMedian || shared ? undefined : teams.get(person.entityId);
    return [roles.get(person.entityId), team ? teamName(team) : undefined]
      .filter(Boolean)
      .join(" · ");
  };

  return (
    <div className="flex flex-col gap-2">
      {shared ? <p className="text-sm text-muted-foreground">{teamName(shared)}</p> : null}
      <div className="max-h-[75svh] overflow-auto rounded-lg border bg-card">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption className="sr-only">{t("metrics_view.compare_caption")}</caption>
          <thead>
            {grouped ? (
              <tr>
                <td className={cn(TEAM_ROW_CELL, STICKY_START, "z-20")} />
                <td className={TEAM_ROW_CELL} />
                {groups.map((group) =>
                  group.team ? (
                    <th
                      key={group.team.id}
                      scope="colgroup"
                      colSpan={group.members.length}
                      className={cn(
                        TEAM_ROW_CELL,
                        "border-s border-s-card bg-secondary px-3 text-start text-xs font-medium",
                      )}
                    >
                      {teamName(group.team)}
                    </th>
                  ) : (
                    <td key="no-team" colSpan={group.members.length} className={TEAM_ROW_CELL} />
                  ),
                )}
              </tr>
            ) : null}
            <tr>
              <th scope="col" className={cn(HEAD_CELL, STICKY_START, headTop, "z-20 min-w-44")}>
                {t("metrics_view.metric")}
              </th>
              {byMedian ? (
                <th scope="col" className={cn(HEAD_CELL, headTop)}>
                  {t("metrics_view.group_median")}
                  <span className={MUTED_LINE}>
                    {t("metrics_view.selected_people", { count: people.length })}
                  </span>
                </th>
              ) : null}
              {columns.map((person) => {
                const note = headerNote(person);
                return (
                  <th key={person.entityId} scope="col" className={cn(HEAD_CELL, headTop)}>
                    <Link
                      to="/people/$person"
                      params={{ person: person.entityId }}
                      className="hover:underline"
                    >
                      {person.displayName}
                    </Link>
                    {note ? <span className={MUTED_LINE}>{note}</span> : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {keys.flatMap((key) => {
              const result = byKey.get(key);
              if (!result) return [];

              const values = columns.map((person) => finiteValue(result, person.entityId));
              return [
                <tr key={key} className="hover:bg-muted/50">
                  <th
                    scope="row"
                    className={cn(STICKY_START, "border-b bg-card px-3 py-2 text-start font-normal")}
                  >
                    {result.label}
                    <span className={MUTED_LINE}>{directionNote(result)}</span>
                  </th>
                  {byMedian ? (
                    <MedianCells result={result} people={columns} values={values} />
                  ) : (
                    <BestCells result={result} people={columns} values={values} />
                  )}
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface CellsProps {
  result: NormalizedMetricResult;
  people: readonly Person[];
  values: ReadonlyArray<number | null>;
}

function BestCells({ result, people, values }: CellsProps) {
  const { t } = useTranslation();
  const cells = compareWithBest(values, result);
  const bestPerson = people[cells.findIndex((cell) => cell.best)];
  const bestName = bestPerson ? firstName(bestPerson.displayName) : "";

  return people.map((person, index) => {
    const cell = cells[index]!;
    const value = <ShownValue result={result} person={person} />;

    return (
      <td key={person.entityId} className={BODY_CELL}>
        {cell.best ? (
          <Chip better>
            {value} <ChipNote>{t("metrics_view.best")}</ChipNote>
          </Chip>
        ) : cell.delta != null ? (
          <Chip better={false}>
            {value}{" "}
            <ChipNote>
              {t("metrics_view.versus", { delta: formatDelta(cell.delta, result), name: bestName })}
            </ChipNote>
          </Chip>
        ) : (
          value
        )}
      </td>
    );
  });
}

function MedianCells({ result, people, values }: CellsProps) {
  const { t } = useTranslation();
  const { median, present, cells } = compareWithMedian(values, result);
  const withBest = (text: string, best: boolean) =>
    best ? `${text} · ${t("metrics_view.best")}` : text;

  return (
    <>
      <td className={cn(BODY_CELL, "bg-muted")}>
        {median == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className={SIDE_BY_SIDE}>
            {formatViewValue(median, result)}
            {present < people.length ? (
              <>
                {" "}
                <span className={MUTED_NOTE}>
                  {t("metrics_view.present_count", { count: present })}
                </span>
              </>
            ) : null}
          </span>
        )}
      </td>
      {people.map((person, index) => {
        const cell = cells[index]!;
        const value = <ShownValue result={result} person={person} />;

        return (
          <td key={person.entityId} className={BODY_CELL}>
            {cell.atMedian ? (
              <span className={SIDE_BY_SIDE}>
                {value}{" "}
                <span className={MUTED_NOTE}>
                  {withBest(t("metrics_view.at_median"), cell.best)}
                </span>
              </span>
            ) : cell.delta != null ? (
              <Chip better={cell.better === true}>
                {value} <ChipNote>{withBest(formatDelta(cell.delta, result), cell.best)}</ChipNote>
              </Chip>
            ) : (
              value
            )}
          </td>
        );
      })}
    </>
  );
}

function ShownValue({ result, person }: { result: NormalizedMetricResult; person: Person }) {
  return (
    <MetricValue
      result={result}
      entityId={person.entityId}
      personName={person.displayName}
      withUnit
    />
  );
}

function Chip({ better, children }: { better: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        SIDE_BY_SIDE,
        "rounded-md px-2 py-0.5 font-semibold",
        better ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

function ChipNote({ children }: { children: ReactNode }) {
  return <span className="text-xs font-normal">{children}</span>;
}

function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}
