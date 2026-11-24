import { useMemo, useState } from "react";

import {
  evidenceSelection,
  type MetricEvidenceSelection,
} from "@/api/metric-drilldown-client";
import {
  useEvidenceScope,
  useMetricEvidenceOptional,
  withOwnTarget,
} from "@/components/metric-evidence-context";
import { Button, Spinner } from "@gears-frontx/ui-kit";
import { MetricName } from "@/components/widgets/metric-name";
import {
  beforeAvailableDataDays,
  isCovered,
  notYetCollectedDays,
  provisionalDays,
  silentDays,
  stripDays,
  type StripDay,
} from "@/lib/insight/day-strip";
import { metricComparisons } from "@/lib/insight/metric-comparison";
import {
  activityEvents,
  finestGrain,
  type DayReading,
} from "@/lib/insight/metric-grain";
import { formatDate, formatMetricValue } from "@/lib/format";
import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import {
  activityEventLabel,
  TYPE_DIMENSION,
  withTypeDimension,
} from "@/lib/metrics/provider-links";
import { RecordLink } from "@/components/record-link";
import { useMetricDaySeries } from "@/queries/metric-day-series";
import { useMetricDetail } from "@/queries/metric-detail";
import {
  useCollectionBoundary,
  useDeclaredMetricDimensions,
} from "@/queries/metric-definitions";
import { cn } from "@/lib/utils";

const EVENTS_SHOWN = 8;

export function MetricActivity({
  metric,
  previous,
  entityId,
  periodNoun,
}: {
  metric: NormalizedMetricResult;
  previous: NormalizedMetricResult | null;
  entityId: string;
  periodNoun: string;
}) {
  const grain = finestGrain(metric);
  const declared = useDeclaredMetricDimensions();
  const base = metric.selection
    ? evidenceSelection(metric.selection, entityId)
    : null;
  const declaredForMetric = base
    ? declared.byMetricKey?.get(base.metric_key)
    : null;
  const selection = base ? withTypeDimension(base, declaredForMetric) : null;
  const ready = grain != null && !declared.isPending;
  const detail = useMetricDetail(selection, ready && grain === "event");
  const series = useMetricDaySeries(selection, ready && grain !== "event");
  const description = metric.description?.trim();
  const data = forEntity(metric, entityId);
  const total = formatMetricValue(data.value, metric.format, metric.unit);
  const against = metricComparisons(metric, previous, entityId);

  return (
    <section className="flex flex-col gap-2 border-t py-4 first:border-t-0">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {/* INVARIANT: a fixed basis, because a flex line breaks on content
            size — with none, the untruncated description decides the width at
            which the figures drop to their own line. */}
        <div className="min-w-0 flex-[1_1_16rem]">
          <MetricName metric={metric} className="text-sm font-medium" />
          {description ? (
            <p className="truncate text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        <div className="ms-auto shrink-0 text-right">
          <div className="text-sm tabular-nums">{total}</div>
          <div className="text-xs text-muted-foreground">
            {[
              against.change
                ? `${against.change} since last ${periodNoun}`
                : null,
              against.median ? `team ${against.median}` : null,
              against.absenceLabel,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
      </header>
      <Body
        grain={grain}
        metric={metric}
        selection={selection}
        detail={detail}
        series={series}
      />
    </section>
  );
}

function Body({
  grain,
  metric,
  selection,
  detail,
  series,
}: {
  grain: ReturnType<typeof finestGrain>;
  metric: NormalizedMetricResult;
  selection: MetricEvidenceSelection | null;
  detail: ReturnType<typeof useMetricDetail>;
  series: ReturnType<typeof useMetricDaySeries>;
}) {
  const source = grain === "event" ? detail : series;
  if (grain == null) {
    return (
      <p className="text-xs text-muted-foreground">
        This metric reports a period total only — no daily or per-item detail is
        available for it.
      </p>
    );
  }
  if (source.isPending) {
    return (
      <div className="flex h-12 items-center">
        <Spinner />
      </div>
    );
  }
  if (source.isError) {
    return (
      <p className="text-xs text-muted-foreground">
        The detail behind this number could not be loaded.{" "}
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() => void source.refetch()}
        >
          Try again
        </button>
      </p>
    );
  }
  if (grain === "event") {
    if (detail.data?.not_ready) return <NoDataYet />;
    const rows = detail.data?.rows ?? [];
    if (rows.length === 0) return <NothingRecorded />;
    return <EventList metric={metric} selection={selection} rows={rows} />;
  }
  if (series.data?.notReady) return <NoDataYet />;
  const readings = series.data?.readings ?? [];
  if (readings.length === 0) return <NothingRecorded />;
  return <DayStrip metric={metric} readings={readings} />;
}

function NothingRecorded() {
  return (
    <p className="text-xs text-muted-foreground">
      Nothing recorded in this period.
    </p>
  );
}

function NoDataYet() {
  return (
    <p className="text-xs text-muted-foreground">
      No data yet — this appears once the connector behind it has synced.
    </p>
  );
}

function EventList({
  metric,
  selection,
  rows,
}: {
  metric: NormalizedMetricResult;
  selection: MetricEvidenceSelection | null;
  rows: NonNullable<ReturnType<typeof useMetricDetail>["data"]>["rows"];
}) {
  const evidence = useMetricEvidenceOptional();
  const scope = useEvidenceScope();
  const metricKey = metric.selection?.metric_key ?? "";
  const events = useMemo(() => activityEvents(rows), [rows]);
  const shown = events.slice(0, EVENTS_SHOWN);
  const rest = events.length - shown.length;
  const typed = events.some((event) => eventType(event.values) != null);

  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col">
        {shown.map((event, index) => {
          const links = event.links ?? {};
          const label = activityEventLabel(metricKey, event.ref, event.title);
          return (
            <li
              key={event.ref ?? `${event.date}-${index}`}
              className="flex items-baseline gap-3 py-1 text-xs"
            >
              <span className="w-14 shrink-0 text-muted-foreground tabular-nums">
                {formatDate(event.date)}
              </span>
              {typed ? (
                <span
                  className="w-24 shrink-0 truncate text-muted-foreground"
                  title={eventType(event.values) ?? undefined}
                >
                  {eventType(event.values) ?? "—"}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">
                {label ? (
                  <RecordLink href={links.title}>{label}</RecordLink>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </span>
              {event.context ? (
                <span className="hidden max-w-[14rem] shrink-0 truncate text-muted-foreground sm:inline">
                  <RecordLink href={links.repository}>
                    {event.context}
                  </RecordLink>
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rest > 0 && evidence && selection ? (
        <Button
          type="button"
          variant="link"
          className="justify-start"
          onClick={() =>
            evidence.openEvidenceTargets(
              withOwnTarget(scope, { selection, label: metric.label }),
              { activeMetricKey: selection.metric_key }
            )
          }
        >
          {rest} more
        </Button>
      ) : null}
    </div>
  );
}

function eventType(values: Readonly<Record<string, unknown>>): string | null {
  const value = values[TYPE_DIMENSION];
  if (typeof value !== "string") return null;
  const type = value.trim();
  return type === "" ? null : type;
}

function dayTitle(metric: NormalizedMetricResult, day: StripDay): string {
  const when = formatDate(day.date, "d MMM");
  if (day.coverage === "before_available_data")
    return `${when} — before available data`;
  if (day.coverage === "not_yet_collected")
    return `${when} — not collected yet`;
  if (day.value == null) return `${when} — no reading`;
  const value = formatMetricValue(day.value, metric.format, metric.unit);
  const suffix = day.provisional ? ", may still change" : "";
  if (day.numerator != null && day.denominator != null) {
    return `${when} — ${value} of ${day.denominator}${suffix}`;
  }
  return `${when} — ${value}${suffix}`;
}

function stripSummary(
  metric: NormalizedMetricResult,
  days: StripDay[],
  period: { from: string; to: string } | undefined
): string {
  const span = period
    ? `${formatDate(period.from)} to ${formatDate(period.to)}`
    : `${days.length} days`;
  const silent = silentDays(days);
  const busiest = days.reduce<StripDay | null>(
    (best, day) =>
      day.value != null && (best?.value == null || day.value > best.value)
        ? day
        : best,
    null
  );
  const pending = notYetCollectedDays(days);
  const before = beforeAvailableDataDays(days);
  const parts = [`${metric.label} by day, ${span}`];
  if (busiest?.value != null)
    parts.push(`busiest ${dayTitle(metric, busiest)}`);
  parts.push(
    silent === 0
      ? "every covered day has a reading"
      : `${silent} ${silent === 1 ? "day has" : "days have"} no reading`
  );
  if (before > 0) {
    parts.push(
      `${before} ${before === 1 ? "day is" : "days are"} before available data`
    );
  }
  if (pending > 0) {
    parts.push(
      `${pending} ${pending === 1 ? "day is" : "days are"} not collected yet`
    );
  }
  const open = provisionalDays(days);
  if (open > 0) {
    parts.push(`${open} ${open === 1 ? "day may" : "days may"} still change`);
  }
  return `${parts.join("; ")}.`;
}

function dayWord(n: number): string {
  return n === 1 ? "day" : "days";
}

function coverageNote(strip: StripDay[]): string | null {
  const before = beforeAvailableDataDays(strip);
  const pending = notYetCollectedDays(strip);
  const parts = [
    before > 0 ? `${before} ${dayWord(before)} before available data` : null,
    pending > 0
      ? `${pending}${before > 0 ? "" : ` ${dayWord(pending)}`} not collected yet`
      : null,
  ].filter((part): part is string => part != null);
  return parts.length === 0 ? null : parts.join(", ");
}

function observedNote(strip: StripDay[]): string | null {
  const silent = silentDays(strip);
  const open = provisionalDays(strip);
  const parts = [
    silent > 0 ? `${silent} ${dayWord(silent)} with no reading` : null,
    open > 0
      ? `${open}${silent > 0 ? "" : ` ${dayWord(open)}`} may still change`
      : null,
  ].filter((part): part is string => part != null);
  return parts.length === 0 ? null : parts.join(", ");
}

function stripNotes(
  strip: StripDay[],
  constantDenominator: number | null
): string | null {
  const notes = [coverageNote(strip), observedNote(strip)].filter(
    (note): note is string => note != null
  );
  if (notes.length < 2 && constantDenominator != null) {
    notes.push(`measured against ${constantDenominator} per day`);
  }
  return notes.length === 0 ? null : notes.join(" · ");
}

function DayStrip({
  metric,
  readings,
}: {
  metric: NormalizedMetricResult;
  readings: DayReading[];
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const period = metric.selection?.period;
  const { collectedFrom, collectedThrough, settledThrough } =
    useCollectionBoundary(metric.metric_key);
  const days = useMemo(
    () =>
      period
        ? stripDays(readings, period.from, period.to, {
            collectedFrom,
            collectedThrough,
            settledThrough,
          })
        : [],
    [readings, period, collectedFrom, collectedThrough, settledThrough]
  );
  if (days.length === 0) return null;

  const hoveredDay = hovered != null ? (days[hovered] ?? null) : null;
  const leftAnchored = hovered != null && hovered < days.length / 2;
  const denominators = new Set(
    days.flatMap((d) => (d.denominator != null ? [d.denominator] : []))
  );
  const constantDenominator =
    denominators.size === 1 ? [...denominators][0] : null;

  return (
    <div className="mt-5 flex flex-col gap-1.5">
      <div
        className="relative flex h-10 items-end gap-px border-b"
        role="img"
        aria-label={stripSummary(metric, days, period)}
        onPointerLeave={() => setHovered(null)}
      >
        {hoveredDay && hovered != null ? (
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-full z-10 mb-1 rounded border bg-popover px-1.5 py-0.5 text-xs whitespace-nowrap text-popover-foreground tabular-nums shadow-sm"
            style={{
              left: `${((hovered + (leftAnchored ? 0 : 1)) / days.length) * 100}%`,
              transform: leftAnchored ? undefined : "translateX(-100%)",
            }}
          >
            {dayTitle(metric, hoveredDay)}
          </div>
        ) : null}
        {days.map((day, index) => (
          <div
            key={day.date}
            onPointerEnter={() => setHovered(index)}
            className="relative flex h-full flex-1 items-end"
          >
            {!isCovered(day) ? (
              <div className="h-full w-full bg-foreground/8" />
            ) : day.height == null ? null : (
              <div
                className={cn(
                  "w-full rounded-t-[1px] bg-foreground/35",
                  day.height === 0 && "bg-foreground/20",
                  day.provisional && "opacity-50"
                )}
                style={{ height: `${Math.max(day.height * 100, 2)}%` }}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{period ? formatDate(period.from) : null}</span>
        <span className="text-center">
          {stripNotes(days, constantDenominator)}
        </span>
        <span>{period ? formatDate(period.to) : null}</span>
      </div>
    </div>
  );
}
