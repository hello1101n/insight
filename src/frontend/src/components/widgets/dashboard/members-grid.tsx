import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@gears-frontx/ui-kit";
import { formatMetricValue, isDurationUnit } from "@/lib/format";
import { absenceLabel } from "@/lib/metrics/absence";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import {
  computeDelta,
  deltaStatus,
  formatTileDelta,
  type MetricDelta,
} from "@/lib/metrics/delta";
import { formatGapMagnitude } from "@/lib/metrics/gap";
import { derivePeerStanding } from "@/lib/metrics/peer-standing";
import {
  rankCounts,
  rankableCount,
  sectionStandingPhrase,
  type RankCounts,
} from "@/lib/scoring";
import type {
  MetricDirection,
  MetricFormat,
} from "@/api/metric-results-client";
import {
  PEER_CELL,
  PEER_FILL,
  PEER_LABEL,
  PEER_TEXT,
  type PeerCohortLabel,
  type PeerStatusWithNeutral,
} from "@/lib/peers";
import { STATUS_TEXT_CLASS } from "@/lib/status";
import { TEXT_FIGURE } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { evidenceSelection } from "@/api/metric-drilldown-client";
import {
  EvidenceScopeContext,
  useEvidenceScope,
  useMetricEvidenceOptional,
  withOwnTarget,
} from "@/components/metric-evidence-context";

const MEMBER_COL_WIDTH =
  "[--member-col:9rem] @min-[26rem]:[--member-col:12rem] @min-[32rem]:[--member-col:16rem]";

const MEMBER_COL_CELL =
  "sticky start-0 z-10 w-[var(--member-col,16rem)] bg-card text-left";

/**
 * INVARIANT: the cap is what gives the roster a scrollport of its own. The
 * headings stick to it, never to the page, so without a height they cannot
 * hold at all.
 */
const ROSTER_SCROLLPORT = "max-h-[75svh] overflow-auto";

const HEADING_CELL =
  "sticky top-0 z-20 bg-card shadow-[0_4px_0_0_var(--card)]";

const METRIC_COL_PX = 108;

export interface MembersGridMember {
  entityId: string;
  displayName: string;
}

export interface MembersGridProps {
  members: MembersGridMember[];
  defaultSort?: "input" | "issues";
  metricKeys: readonly string[];
  byKey: Map<string, NormalizedMetricResult>;
  previousByKey?: Map<string, NormalizedMetricResult>;
  countsByMember?: Map<string, RankCounts>;
  worstByMember?: Map<string, string | null>;
  showIssues?: boolean;
  caption: string;
  cohortLabel?: PeerCohortLabel;
  className?: string;
}

interface Column {
  key: string;
  heading: string;
  label: string;
  unit: string | null;
  format: MetricFormat;
  direction: MetricDirection;
  metric: NormalizedMetricResult;
}

function columnFor(metric: NormalizedMetricResult): Column {
  return {
    key: metric.metric_key,
    heading: metric.short_label ?? metric.label,
    label: metric.label,
    unit: metric.unit,
    format: metric.format,
    direction: metric.direction,
    metric,
  };
}

interface CellShape {
  col: Column;
  value: number | null;
  previous: number | null;
  delta: MetricDelta | null;
  status: PeerStatusWithNeutral;
  median: number | null;
  gapPct: number | null;
  gapDelta: number;
  severity: number;
  observed: boolean;
}

interface RowShape {
  member: MembersGridMember;
  cells: CellShape[];
  counts: RankCounts;
  worstLabel: string | null;
}

type SortKey = "name" | "issues" | string;
type SortDirection = "ascending" | "descending";

type SortState =
  | { key: null }
  | { key: SortKey; direction: SortDirection };

function cellDisplay(value: number | null, col: Column): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const unit = isDurationUnit(col.unit) ? col.unit : null;
  return formatMetricValue(value, col.format, unit);
}

function fullDisplay(value: number | null, col: Column): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return formatMetricValue(value, col.format, col.unit);
}

function cellMissing(cell: CellShape | undefined): boolean {
  return !cell?.observed || cell.value == null || !Number.isFinite(cell.value);
}

export function MembersGrid({
  members,
  defaultSort = "issues",
  metricKeys,
  byKey,
  previousByKey,
  countsByMember,
  worstByMember,
  showIssues,
  caption,
  cohortLabel = "department",
  className,
}: MembersGridProps) {
  const hasIssuesFacet = showIssues ?? countsByMember != null;
  const [sort, setSort] = useState<SortState>({ key: null });

  const toggleSort = (
    key: SortKey,
    firstDirection: SortDirection = "ascending",
  ) => {
    setSort((current) => {
      if (current.key !== key) return { key, direction: firstDirection };
      if (current.direction === firstDirection) {
        return {
          key,
          direction:
            firstDirection === "ascending" ? "descending" : "ascending",
        };
      }
      return { key: null };
    });
  };

  const columns = useMemo(
    () =>
      metricKeys.flatMap((key) => {
        const metric = byKey.get(key);
        return metric ? [columnFor(metric)] : [];
      }),
    [metricKeys, byKey]
  );

  const rows = useMemo<RowShape[]>(() => {
    return members.map((member) => {
      const cells = columns.map((col) => {
        const metric = byKey.get(col.key)!;
        const data = forEntity(metric, member.entityId);
        const standing = derivePeerStanding(metric.direction, {
          value: data.value,
          peer: data.peer,
          absence: data.absence,
        });
        const prevMetric = previousByKey?.get(col.key);
        const previous = prevMetric
          ? forEntity(prevMetric, member.entityId).value
          : null;
        const delta = standing.observed
          ? computeDelta(
              data.value,
              previous,
              metric.computation,
              metric.format
            )
          : null;
        return {
          col,
          value: data.value,
          previous,
          delta,
          status: standing.rank,
          median: standing.stats?.p50 ?? null,
          gapPct: standing.gapPct,
          gapDelta: standing.gapDelta,
          severity: standing.severity,
          observed: standing.observed,
        };
      });
      const below = cells.filter((cell) => cell.status === "bottom");
      const selfWorst =
        below.length > 0
          ? below.reduce((worst, cell) =>
              cell.severity > worst.severity ? cell : worst
            ).col.label
          : null;
      return {
        member,
        cells,
        counts:
          countsByMember?.get(member.entityId) ??
          rankCounts(cells.map((cell) => ({ row: cell, rank: cell.status }))),
        worstLabel: worstByMember?.get(member.entityId) ?? selfWorst,
      };
    });
  }, [members, columns, byKey, previousByKey, countsByMember, worstByMember]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    if (sort.key == null) {
      if (defaultSort === "issues") {
        copy.sort(
          (a, b) =>
            b.counts.bottom - a.counts.bottom ||
            a.member.displayName.localeCompare(b.member.displayName),
        );
      }
      return copy;
    }

    const flip = sort.direction === "descending" ? -1 : 1;
    if (sort.key === "name") {
      copy.sort(
        (a, b) =>
          flip * a.member.displayName.localeCompare(b.member.displayName)
      );
    } else if (sort.key === "issues") {
      copy.sort(
        (a, b) =>
          flip * (a.counts.bottom - b.counts.bottom) ||
          a.member.displayName.localeCompare(b.member.displayName)
      );
    } else {
      const colIdx = columns.findIndex((c) => c.key === sort.key);
      const col = columns[colIdx];
      if (col) {
        copy.sort((a, b) => {
          const ac = a.cells[colIdx];
          const bc = b.cells[colIdx];
          const aMissing = cellMissing(ac);
          const bMissing = cellMissing(bc);
          if (aMissing || bMissing) return Number(aMissing) - Number(bMissing);
          return flip * (ac!.value! - bc!.value!);
        });
      }
    }
    return copy;
  }, [rows, sort, columns, defaultSort]);

  const directionFor = (
    key: SortKey
  ): "ascending" | "descending" | undefined => {
    if (sort.key !== key) return undefined;
    return sort.direction;
  };

  const memberDirection = directionFor("issues") ?? directionFor("name");
  const memberSortActive = sort.key === "issues" || sort.key === "name";

  return (
    <div className={cn("@container flex flex-col gap-3", className)}>
      <div className={cn(ROSTER_SCROLLPORT, MEMBER_COL_WIDTH)}>
        <table
          className="w-full max-w-[1600px] table-fixed border-separate border-spacing-1"
          style={{
            minWidth: `calc(var(--member-col, 16rem) + ${columns.length * METRIC_COL_PX}px)`,
          }}
        >
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                aria-sort={memberDirection}
                className={cn(MEMBER_COL_CELL, HEADING_CELL, "z-30 px-2")}
              >
                {hasIssuesFacet ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <button
                          type="button"
                          className={cn(
                            "flex cursor-pointer items-center gap-1 text-xs font-medium tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground",
                            memberSortActive && "text-foreground"
                          )}
                        >
                          Person
                          <SortArrow direction={memberDirection} />
                        </button>
                      }
                    />
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem
                        onClick={() => toggleSort("issues", "descending")}
                      >
                        Furthest behind
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toggleSort("name")}>
                        Name
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleSort("name")}
                    className={cn(
                      "flex cursor-pointer items-center gap-1 text-xs font-medium tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground",
                      sort.key === "name" && "text-foreground"
                    )}
                  >
                    Person
                    <SortArrow direction={directionFor("name")} />
                  </button>
                )}
              </th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={directionFor(col.key)}
                  className={cn(HEADING_CELL, "p-0")}
                >
                  <ColumnHeader
                    col={col}
                    active={sort.key === col.key}
                    direction={directionFor(col.key)}
                    onClick={() => toggleSort(col.key)}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <MemberRow
                key={row.member.entityId}
                row={row}
                showIssues={hasIssuesFacet}
                cohortLabel={cohortLabel}
              />
            ))}
          </tbody>
        </table>
      </div>
      <Legend />
    </div>
  );
}

function MemberRow({
  row,
  showIssues,
  cohortLabel,
}: {
  row: RowShape;
  showIssues: boolean;
  cohortLabel: PeerCohortLabel;
}) {
  const { member, cells, counts, worstLabel } = row;
  const chipText = showIssues ? sectionStandingPhrase(counts) : null;
  const chipRank: PeerStatusWithNeutral =
    rankableCount(counts) === 0
      ? "neutral"
      : counts.bottom > 0
        ? "bottom"
        : counts.top > 0
          ? "top"
          : "in_pack";
  const rowEvidenceTargets = cells.flatMap((cell) => {
    if (!cell.col.metric.drilldown) return [];
    const selection = evidenceSelection(
      cell.col.metric.selection,
      member.entityId
    );
    return selection ? [{ selection, label: cell.col.label }] : [];
  });
  return (
    <tr>
      <th
        scope="row"
        className={cn(MEMBER_COL_CELL, "px-2 py-1 font-normal")}
      >
        <div className="flex min-h-12 flex-col justify-center gap-0.5">
          <div className="flex items-center gap-1.5">
            <Link
              to="/people/$person"
              params={{ person: member.entityId }}
              className="min-w-0 truncate text-sm leading-tight font-medium hover:underline"
            >
              {member.displayName}
            </Link>
            {chipText != null ? (
              <span
                className={cn(
                  "shrink-0 rounded-sm px-1.5 py-0.5 text-xs font-medium",
                  PEER_CELL[chipRank]
                )}
              >
                {chipText}
              </span>
            ) : null}
          </div>
          {showIssues && counts.bottom > 0 && worstLabel ? (
            <p className="truncate text-xs leading-tight text-muted-foreground">
              worst: {worstLabel}
            </p>
          ) : null}
        </div>
      </th>
      <EvidenceScopeContext.Provider value={rowEvidenceTargets}>
        {cells.map((cell) => (
          <td key={cell.col.key} className="p-0 align-middle">
            <GridCell
              cell={cell}
              entityId={member.entityId}
              memberName={member.displayName}
              cohortLabel={cohortLabel}
            />
          </td>
        ))}
      </EvidenceScopeContext.Provider>
    </tr>
  );
}

function GridCell({
  cell,
  entityId,
  memberName,
  cohortLabel,
}: {
  cell: CellShape;
  entityId: string;
  memberName: string;
  cohortLabel: PeerCohortLabel;
}) {
  const evidenceContext = useMetricEvidenceOptional();
  const scope = useEvidenceScope();
  const { col, value, previous, delta, median, observed } = cell;
  const leaveLabel = absenceLabel(col.metric.absenceContext?.get(entityId));
  const evidence = col.metric.drilldown
    ? evidenceSelection(
        col.metric.selection,
        entityId,
        undefined,
        undefined,
        col.metric.breakdown?.dimensions
      )
    : null;
  const deltaText = delta ? formatTileDelta(delta) : null;
  const showTrend = deltaText != null;
  const trendUp = delta != null && delta.value > 0;
  const TrendIcon = trendUp ? ArrowUp : ArrowDown;
  const trendTint = delta && !leaveLabel
    ? STATUS_TEXT_CLASS[deltaStatus(delta, col.direction)]
    : "text-muted-foreground";
  const display = observed ? cellDisplay(value, col) : "—";
  const displayWithUnit = observed ? fullDisplay(value, col) : "—";
  const gapText =
    value != null && median != null && Math.abs(cell.gapDelta) > 1e-9
      ? formatGapMagnitude({
          value,
          median,
          gapPct: cell.gapPct,
          gapDelta: cell.gapDelta,
          format: col.format,
          unit: col.unit,
        })
      : null;
  const showStanding = observed && cell.status !== "neutral";
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        // WORKAROUND: base-ui's PreviewCard closes 300ms after mouse-out by default,
        // so the previous cell's card lingers beside the next one.
        closeDelay={0}
        render={
          <button
            type="button"
            onClick={() => {
              if (!evidence) return;
              evidenceContext?.openEvidenceTargets(
                withOwnTarget(scope, {
                  selection: evidence,
                  label: col.label,
                }),
                { activeMetricKey: evidence.metric_key }
              );
            }}
            aria-label={
              observed
                ? `${memberName} — ${col.label}: ${displayWithUnit} — ${PEER_LABEL[cell.status]}${leaveLabel ? ` — ${leaveLabel}` : ""}`
                : `${memberName} — ${col.label}: not recorded`
            }
            className={cn(
              "flex h-12 w-full items-center justify-center rounded-sm px-3 text-sm font-medium tabular-nums transition hover:brightness-95",
              PEER_CELL[cell.status]
            )}
          >
            <span className="relative inline-flex items-center">
              {display}
              {showTrend && value != null ? (
                <TrendIcon
                  className={cn("absolute left-full ml-0.5 size-3", trendTint)}
                  aria-hidden
                />
              ) : null}
            </span>
          </button>
        }
      />
      <HoverCardContent>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">{col.label}</p>
          <p className="text-xs text-muted-foreground">{memberName}</p>
          <p className={cn("mt-2", TEXT_FIGURE, "", PEER_TEXT[cell.status])}>
            {displayWithUnit}
          </p>
          <p className="text-xs text-muted-foreground">
            {!observed ? (
              median != null ? (
                `Not recorded · ${cohortLabel} median ${formatMetricValue(median, col.format, col.unit)}`
              ) : (
                "Not recorded"
              )
            ) : median == null ? (
              "No comparison"
            ) : gapText != null ? (
              <>
                <span className={cn("font-medium", PEER_TEXT[cell.status])}>
                  {gapText}
                </span>{" "}
                from {cohortLabel} median{" "}
                {formatMetricValue(median, col.format, col.unit)}
              </>
            ) : (
              `At the ${cohortLabel} median (${formatMetricValue(median, col.format, col.unit)})`
            )}
          </p>
          {showTrend && previous != null ? (
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              vs previous period:{" "}
              <span className={cn("font-medium", trendTint)}>{deltaText}</span>{" "}
              (was {formatMetricValue(previous, col.format, col.unit)})
            </p>
          ) : null}
          {showStanding ? (
            <p className={cn("mt-1 text-xs font-medium", PEER_TEXT[cell.status])}>
              {PEER_LABEL[cell.status]}
            </p>
          ) : null}
          {leaveLabel ? (
            <p className="mt-1 text-xs text-muted-foreground">{leaveLabel}</p>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function SortArrow({
  direction,
  className,
}: {
  direction: "ascending" | "descending" | undefined;
  className?: string;
}) {
  if (!direction) return null;
  const Icon = direction === "ascending" ? ArrowUp : ArrowDown;
  return <Icon className={cn("size-3 shrink-0", className)} aria-hidden />;
}

function ColumnHeader({
  col,
  active,
  direction,
  onClick,
}: {
  col: Column;
  active: boolean;
  direction: "ascending" | "descending" | undefined;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-9 w-full cursor-pointer items-center justify-center px-4 text-xs font-medium tracking-wider text-muted-foreground uppercase transition-colors hover:text-foreground",
        active && "text-foreground"
      )}
      aria-label={t("common.legend.sort_column", { column: col.label })}
      title={col.label}
    >
      <span className="relative inline-flex max-w-full items-center">
        <span className="truncate">{col.heading}</span>
        <SortArrow
          direction={direction}
          className="absolute left-full ml-0.5"
        />
      </span>
    </button>
  );
}

function Legend() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-4 px-3 text-xs text-muted-foreground">
      <LegendSwatch className={PEER_FILL.top}>{t("common.legend.top")}</LegendSwatch>
      <LegendSwatch className={PEER_FILL.in_pack}>{t("common.legend.near_median")}</LegendSwatch>
      <LegendSwatch className={PEER_FILL.bottom}>{t("common.legend.bottom")}</LegendSwatch>
      <LegendSwatch className={PEER_FILL.neutral}>{t("common.legend.no_comparison")}</LegendSwatch>
    </div>
  );
}

function LegendSwatch({
  className,
  children,
}: {
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-block size-3 rounded-sm", className)} />
      {children}
    </span>
  );
}
