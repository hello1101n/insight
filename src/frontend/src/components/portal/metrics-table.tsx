import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronRight, Info } from "lucide-react";

import type { DateRange } from "@/api/period-to-date-range";
import { evidenceSelection } from "@/api/metric-drilldown-client";
import { useMetricEvidenceOptional } from "@/components/metric-evidence-context";
import {
  PersonalRecordsDialog,
  type PersonalRecordsTarget,
} from "@/components/portal/personal-records-dialog";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@gears-frontx/ui-kit";
import { formatRange } from "@/lib/date-range-label";
import { formatMetricFigure, formatMetricValue, formatUtcInstant } from "@/lib/format";
import { finiteValue, type NormalizedMetricResult } from "@/lib/metrics/collection";
import {
  combinedColumn,
  combinedParts,
  type CombinedColumn,
} from "@/lib/portal/metrics-view-combined";
import {
  headerUnit,
  type MetricGroup,
  type MetricsRow,
  type SortDirection,
} from "@/lib/portal/metrics-view";
import {
  CALCULATION_LABEL,
  type PersonalMetricDefinition,
} from "@/lib/portal/personal-metrics";
import { TEXT_BODY, TEXT_NAME } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

export interface MetricsSort {
  key: string;
  direction: SortDirection;
}

const GROUP_ROW_HEIGHT = "h-7";
const BELOW_GROUP_ROW = "top-7";
const HEADER_CELL = "sticky z-20 border-b bg-card px-2 text-start";
const NAME_CELL = "sticky start-0 z-10 bg-card";
const NO_PERSONAL: ReadonlyMap<string, PersonalMetricDefinition> = new Map();
const NO_KEYS: ReadonlySet<string> = new Set();

export function MetricsTable({
  rows,
  groups,
  byKey,
  personal = NO_PERSONAL,
  failed = NO_KEYS,
  pending = NO_KEYS,
  roles,
  sort,
  onSort,
  range,
  onToggle,
  onScope,
}: {
  rows: readonly MetricsRow[];
  groups: readonly MetricGroup[];
  byKey: ReadonlyMap<string, NormalizedMetricResult>;
  personal?: ReadonlyMap<string, PersonalMetricDefinition>;
  failed?: ReadonlySet<string>;
  pending?: ReadonlySet<string>;
  roles: ReadonlyMap<string, string>;
  sort: MetricsSort | null;
  onSort: (metricKey: string) => void;
  range?: DateRange;
  onToggle: (entityId: string) => void;
  onScope: (entityId: string) => void;
}) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<PersonalRecordsTarget | null>(null);
  const keys = groups.flatMap((group) => group.keys);
  const groupStarts = new Set(groups.slice(1).map((group) => group.keys[0]));

  return (
    <div className="max-h-[calc(100svh-13rem)] overflow-auto rounded-lg border bg-card">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{t("metrics_view.people_caption")}</caption>
        <thead>
          <tr className={GROUP_ROW_HEIGHT}>
            <th
              scope="col"
              rowSpan={2}
              className={cn(
                HEADER_CELL,
                NAME_CELL,
                "top-0 z-30 min-w-64 border-e align-bottom py-2 font-semibold",
              )}
            >
              Person
            </th>
            {groups.map((group) => (
              <th
                key={group.family}
                scope="colgroup"
                colSpan={group.keys.length}
                className={cn(
                  HEADER_CELL,
                  "top-0 border-s text-xs font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase",
                )}
              >
                {group.name}
              </th>
            ))}
          </tr>
          <tr>
            {keys.map((key) => {
              const result = byKey.get(key);
              const definition = personal.get(key);
              const label = definition?.label ?? result?.label ?? key;
              const direction = sort?.key === key ? sort.direction : undefined;
              return (
                <th
                  key={key}
                  scope="col"
                  aria-sort={direction}
                  aria-busy={pending.has(key) || undefined}
                  className={cn(
                    HEADER_CELL,
                    BELOW_GROUP_ROW,
                    "min-w-28 max-w-36 py-2 align-bottom",
                    groupStarts.has(key) && "border-s",
                  )}
                >
                  <div className="flex items-end justify-end gap-1">
                    <button
                      type="button"
                      aria-label={`Sort by ${label}`}
                      onClick={() => onSort(key)}
                      className="flex min-w-0 flex-1 cursor-pointer items-end justify-end gap-1 text-end text-xs leading-tight font-semibold hover:text-primary"
                    >
                      <span className="whitespace-normal">
                        {label}
                        {definition ? (
                          <span className="block font-normal text-muted-foreground">
                            {personalNote(definition)}
                          </span>
                        ) : (
                          <UnitNote result={result} className="block" />
                        )}
                        {failed.has(key) ? (
                          <span className="block font-normal text-destructive">
                            {t("metrics_view.not_loaded")}
                          </span>
                        ) : pending.has(key) ? (
                          <span className="block font-normal text-muted-foreground">
                            {t("metrics_view.loading")}
                          </span>
                        ) : null}
                      </span>
                      {direction === "descending" ? (
                        <ArrowDown className="size-3 shrink-0" aria-hidden />
                      ) : direction === "ascending" ? (
                        <ArrowUp className="size-3 shrink-0" aria-hidden />
                      ) : null}
                    </button>
                    {definition ? <PersonalInfo definition={definition} /> : null}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.entityId} className="group hover:bg-muted/60">
              <th
                scope="row"
                className={cn(
                  NAME_CELL,
                  "border-e border-b px-2 py-1 text-start font-normal whitespace-nowrap group-hover:bg-muted",
                )}
              >
                <div className="flex items-center gap-1">
                  <span
                    aria-hidden
                    className="shrink-0"
                    style={{ inlineSize: `${row.depth * 1.25}rem` }}
                  />
                  {row.hasReports ? (
                    <button
                      type="button"
                      aria-label={`${row.expanded ? "Collapse" : "Expand"} ${row.displayName}`}
                      aria-expanded={row.expanded}
                      onClick={() => onToggle(row.entityId)}
                      className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <ChevronRight
                        className={cn("size-3.5 transition-transform", row.expanded && "rotate-90")}
                      />
                    </button>
                  ) : (
                    <span aria-hidden className="size-5 shrink-0" />
                  )}
                  <button
                    type="button"
                    onClick={() => onScope(row.entityId)}
                    className="cursor-pointer truncate font-medium hover:underline"
                  >
                    {row.displayName}
                  </button>
                  {roles.get(row.entityId) ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {roles.get(row.entityId)}
                    </span>
                  ) : null}
                  <Link
                    to="/people/$person"
                    params={{ person: row.entityId }}
                    aria-label={`Open ${row.displayName}`}
                    className="ms-auto shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                  >
                    <ArrowUpRight className="size-3.5" />
                  </Link>
                </div>
              </th>
              {keys.map((key) => (
                <td
                  key={key}
                  className={cn(
                    "border-b px-2 py-1 text-end whitespace-nowrap tabular-nums",
                    groupStarts.has(key) && "border-s",
                  )}
                >
                  {pending.has(key) ? (
                    <span
                      aria-hidden
                      className="inline-block h-3 w-10 animate-pulse rounded bg-muted align-middle"
                    />
                  ) : (
                    <MetricCell
                      metricKey={key}
                      byKey={byKey}
                      entityId={row.entityId}
                      personName={row.displayName}
                      onOpen={
                        personal.get(key) && range
                          ? (value) =>
                              setRecords({
                                metric: personal.get(key)!,
                                personId: row.entityId,
                                personName: row.displayName,
                                value,
                              })
                          : undefined
                      }
                    />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {range ? (
        <PersonalRecordsDialog
          target={records}
          range={range}
          onClose={() => setRecords(null)}
        />
      ) : null}
    </div>
  );
}

export function MetricValue({
  result,
  entityId,
  personName,
  onOpen,
}: {
  result: NormalizedMetricResult | undefined;
  entityId: string;
  personName: string;
  onOpen?: (shown: string) => void;
}) {
  const evidence = useMetricEvidenceOptional();
  const value = result ? finiteValue(result, entityId) : null;
  if (!result || value == null) {
    return <span className="text-muted-foreground">—</span>;
  }

  const text = formatMetricFigure(value, result.format, result.unit);
  const fullText = formatMetricValue(value, result.format, result.unit);
  if (onOpen) {
    return (
      <button
        type="button"
        aria-label={`${personName} — ${result.label}: ${fullText}`}
        onClick={() => onOpen(text)}
        className="cursor-pointer hover:text-primary hover:underline"
      >
        {text}
      </button>
    );
  }
  const selection = result.drilldown
    ? evidenceSelection(result.selection, entityId)
    : null;
  if (!selection || !evidence) return <span>{text}</span>;

  return (
    <button
      type="button"
      aria-label={`${personName} — ${result.label}: ${fullText}`}
      onClick={() =>
        evidence.openEvidenceTargets([{ selection, label: result.label }], {
          activeMetricKey: selection.metric_key,
          title: [
            result.label,
            personName,
            fullText,
            formatRange(selection.period.from, selection.period.to),
          ].join(" · "),
        })
      }
      className="cursor-pointer hover:text-primary hover:underline"
    >
      {text}
    </button>
  );
}

function personalNote(definition: PersonalMetricDefinition): string {
  return [
    CALCULATION_LABEL[definition.calculation],
    headerUnit(definition.label, definition.format, definition.unit),
  ]
    .filter(Boolean)
    .join(" · ");
}

function PersonalInfo({ definition }: { definition: PersonalMetricDefinition }) {
  const { t } = useTranslation();
  const description = definition.description?.trim();
  const shared = definition.shared_by;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("metrics_view.about_metric", { label: definition.label })}
            className="shrink-0 cursor-pointer rounded-full text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Info className="size-3.5" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-2 p-3">
        <PopoverTitle className={TEXT_NAME}>{definition.label}</PopoverTitle>
        {description ? (
          <PopoverDescription className={TEXT_BODY}>{description}</PopoverDescription>
        ) : null}
        <p className={cn(TEXT_BODY, "text-muted-foreground")}>
          {t(`metrics_view.direction.${definition.direction}`)}
        </p>
        {shared ? (
          <p className={cn(TEXT_BODY, "text-muted-foreground")}>
            {t("metrics_view.shared_by", {
              name: shared.name ?? shared.person_id,
              date: formatUtcInstant(shared.at, "d MMM yyyy"),
            })}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function MetricCell({
  metricKey,
  byKey,
  entityId,
  personName,
  onOpen,
}: {
  metricKey: string;
  byKey: ReadonlyMap<string, NormalizedMetricResult>;
  entityId: string;
  personName: string;
  onOpen?: (shown: string) => void;
}) {
  const column = combinedColumn(metricKey);
  if (column) {
    return (
      <CombinedValue
        column={column}
        byKey={byKey}
        entityId={entityId}
        personName={personName}
      />
    );
  }
  return (
    <MetricValue
      result={byKey.get(metricKey)}
      entityId={entityId}
      personName={personName}
      onOpen={onOpen}
    />
  );
}

function CombinedValue({
  column,
  byKey,
  entityId,
  personName,
}: {
  column: CombinedColumn;
  byKey: ReadonlyMap<string, NormalizedMetricResult>;
  entityId: string;
  personName: string;
}) {
  const evidence = useMetricEvidenceOptional();
  const parts = combinedParts(column, byKey, entityId);
  if (!parts) return <span className="text-muted-foreground">—</span>;

  const text = parts.map((part) => part.text).join(" / ");
  const targets = parts.flatMap(({ result }) => {
    const selection = result?.drilldown
      ? evidenceSelection(result.selection, entityId)
      : null;
    return result && selection ? [{ selection, label: result.label }] : [];
  });
  const [first] = targets;
  if (!evidence || !first) return <span>{text}</span>;

  const figure = `${text} ${column.unit}`;
  return (
    <button
      type="button"
      aria-label={`${personName} — ${column.label}: ${figure}`}
      onClick={() =>
        evidence.openEvidenceTargets(targets, {
          title: [
            column.label,
            personName,
            figure,
            formatRange(first.selection.period.from, first.selection.period.to),
          ].join(" · "),
        })
      }
      className="-mx-1 cursor-pointer rounded-sm px-1 hover:bg-primary/10 hover:text-primary"
    >
      {text}
    </button>
  );
}

export function UnitNote({
  result,
  className,
}: {
  result: NormalizedMetricResult | undefined;
  className: string;
}) {
  const unit = result ? headerUnit(result.label, result.format, result.unit) : null;
  if (!unit) return null;
  return <span className={cn("font-normal text-muted-foreground", className)}>{unit}</span>;
}
