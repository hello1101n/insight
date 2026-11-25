import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from "lucide-react";

import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";

import { formatMetricNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MetricTimeseriesModel } from "@/components/widgets/metric-views/metric-timeseries-model";
import {
  EDGE_SLACK_PX,
  GUTTER_PX,
  gutterState,
  resolveMetricTimeseriesTableColumns,
  type MetricTimeseriesTableColumn,
} from "@/components/widgets/metric-views/metric-timeseries-table-model";
import type { MetricTimeseriesTableConfig } from "@/lib/metrics/timeseries-table";

export interface MetricTimeseriesTableProps {
  model: MetricTimeseriesModel;
  config?: MetricTimeseriesTableConfig;
  onVerticalOverflow?: (overflows: boolean) => void;
  onEvidence?: (
    metricKey: string,
    columnKey: string | null,
    bucketStart: string | null
  ) => void;
}

type Side = "start" | "end" | "up" | "down";

const SIDES: readonly Side[] = ["start", "end", "up", "down"];
const NOTHING_MORE: Record<Side, boolean> = {
  start: false,
  end: false,
  up: false,
  down: false,
};

const NO_GUTTERS = { start: false, end: false };

const NEARLY_A_FRAME = 0.8;

const SIDE_CHROME: Record<
  Side,
  { icon: typeof ChevronLeft; label: string; place: string }
> = {
  start: {
    icon: ChevronLeft,
    label: "Show earlier columns",
    place: "start-1 top-1/2 -translate-y-1/2 rtl:rotate-180",
  },
  end: {
    icon: ChevronRight,
    label: "Show later columns",
    place: "end-1 top-1/2 -translate-y-1/2 rtl:rotate-180",
  },
  up: {
    icon: ChevronUp,
    label: "Show earlier rows",
    place: "top-1 end-1",
  },
  down: {
    icon: ChevronDown,
    label: "Show later rows",
    place: "bottom-1 end-1",
  },
};

const BUCKET_COL_WIDTH = "[--bucket-col:6rem]";
const BUCKET_COL = "w-(--bucket-col) max-w-(--bucket-col) min-w-(--bucket-col)";
const PAST_BUCKET_COL = "start-(--bucket-col)";

const BUCKET_LABEL = {
  day: "Day",
  week: "Week",
  month: "Month",
} as const;

const TONE_CLASS = {
  default: undefined,
  muted: "text-muted-foreground",
  success: "text-success",
  destructive: "text-destructive",
} as const;

function MetricTableValue({
  column,
  valueFor,
  onMetricClick,
}: {
  column: MetricTimeseriesTableColumn;
  valueFor: (metricKey: string) => number | null | undefined;
  onMetricClick?: (metricKey: string) => void;
}) {
  const hasValue = column.parts.some(
    (part) => part.kind === "metric" && valueFor(part.metricKey) != null
  );
  if (!hasValue) return <>—</>;

  return (
    <span>
      {column.parts.map((part, index) => {
        if (part.kind === "text") return <span key={index}>{part.text}</span>;
        const value = valueFor(part.metricKey);
        const metric = part.metric;
        if (value == null || !metric) {
          return (
            <span
              key={`${part.metricKey}-${index}`}
              className={TONE_CLASS.muted}
            >
              —
            </span>
          );
        }
        const content = (
          <>
            {part.prefix}
            {formatMetricNumber(value, metric.format)}
          </>
        );
        return onMetricClick ? (
          <button
            key={`${part.metricKey}-${index}`}
            type="button"
            className={cn(TONE_CLASS[part.tone], "hover:underline")}
            onClick={() => onMetricClick(part.metricKey)}
          >
            {content}
          </button>
        ) : (
          <span
            key={`${part.metricKey}-${index}`}
            className={TONE_CLASS[part.tone]}
          >
            {content}
          </span>
        );
      })}
    </span>
  );
}

export function MetricTimeseriesTable({
  model,
  config,
  onVerticalOverflow,
  onEvidence,
}: MetricTimeseriesTableProps) {
  const tableColumns = resolveMetricTimeseriesTableColumns(model, config);
  const grandTotals = new Map(
    model.metrics.map((metric, index) => [
      metric.metric_key,
      model.grandTotals[index],
    ])
  );
  const hasGrandTotal = tableColumns.some((column) =>
    column.parts.some(
      (part) =>
        part.kind === "metric" && grandTotals.get(part.metricKey) != null
    )
  );

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(NOTHING_MORE);
  const [gutters, setGutters] = useState(NO_GUTTERS);
  const measure = useCallback(() => {
    const box = boxRef.current;
    const wrap = wrapRef.current;
    if (!box || !wrap) return;
    // WORKAROUND: `scrollLeft` is negative in RTL.
    const across = Math.abs(box.scrollLeft);
    const acrossRoom = box.scrollWidth - box.clientWidth;
    const downRoom = box.scrollHeight - box.clientHeight;
    const next = {
      start: across > EDGE_SLACK_PX,
      end: across < acrossRoom - EDGE_SLACK_PX,
      up: box.scrollTop > EDGE_SLACK_PX,
      down: box.scrollTop < downRoom - EDGE_SLACK_PX,
    };
    setMore((prev) =>
      SIDES.every((side) => prev[side] === next[side]) ? prev : next
    );

    const rows = box.querySelector("table");
    const naturalWidth = rows?.offsetWidth ?? box.scrollWidth;
    const scrollsDown = downRoom > EDGE_SLACK_PX;
    const nextGutters = gutterState(wrap.clientWidth, naturalWidth, scrollsDown);
    setGutters((prev) =>
      prev.start === nextGutters.start && prev.end === nextGutters.end
        ? prev
        : nextGutters
    );

    onVerticalOverflow?.(scrollsDown);
  }, [onVerticalOverflow]);
  useEffect(() => {
    measure();
    const box = boxRef.current;
    if (!box) return;
    // WORKAROUND: the ui-kit `Table` spreads `onScroll` onto the `<table>`;
    // its scrolling container accepts only `containerRef`.
    box.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(box);
    const inner = box.querySelector("table");
    if (inner) observer?.observe(inner);
    return () => {
      box.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [measure]);

  function page(side: Side): void {
    const box = boxRef.current;
    if (!box) return;
    const forward = side === "end" || side === "down";
    if (side === "up" || side === "down") {
      const step = box.clientHeight * NEARLY_A_FRAME;
      box.scrollBy({ top: forward ? step : -step, behavior: "smooth" });
      return;
    }
    const step = box.clientWidth * NEARLY_A_FRAME;
    const rtl = getComputedStyle(box).direction === "rtl";
    const delta = forward ? step : -step;
    box.scrollBy({ left: rtl ? -delta : delta, behavior: "smooth" });
  }

  return (
    <div
      ref={wrapRef}
      className={cn("relative h-full", BUCKET_COL_WIDTH)}
      style={{
        paddingInlineStart: gutters.start ? GUTTER_PX : undefined,
        paddingInlineEnd: gutters.end ? GUTTER_PX : undefined,
      }}
    >
      {SIDES.filter((side) => more[side]).map((side) => {
        const { icon: Icon, label, place } = SIDE_CHROME[side];
        return (
          <Button
            key={side}
            type="button"
            variant="outline"
            size="sm"
            aria-label={label}
            title={label}
            onClick={() => page(side)}
            className={cn(
              "absolute z-40",
              place
            )}
            icon={<Icon className="size-4" />}
          />
        );
      })}
      <Table
        className="min-w-max"
        containerClassName="h-full overflow-auto"
        containerRef={boxRef}
      >
      <TableHeader>
        {model.dimensions.length === 0 ? (
          <TableRow>
            <TableHead className={cn(BUCKET_COL, "sticky top-0 left-0 z-30 h-10 bg-card shadow-[inset_0_-1px_0_0_var(--border)]")}>
              {BUCKET_LABEL[model.bucket]}
            </TableHead>
            {tableColumns.map((column) => (
              <TableHead
                key={column.key}
                className="sticky top-0 z-20 h-10 min-w-24 bg-card text-right shadow-[inset_0_-1px_0_0_var(--border)]"
              >
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        ) : tableColumns.length === 1 ? (
          <TableRow>
            <TableHead className={cn(BUCKET_COL, "sticky top-0 left-0 z-30 h-10 bg-card shadow-[inset_0_-1px_0_0_var(--border)]")}>
              {BUCKET_LABEL[model.bucket]}
            </TableHead>
            {model.columns.map((column) => (
              <TableHead
                key={column.key}
                className="sticky top-0 z-20 h-10 min-w-24 bg-card text-center shadow-[inset_0_-1px_0_0_var(--border)]"
              >
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        ) : (
          <>
            <TableRow>
              <TableHead className={cn(BUCKET_COL, "sticky top-0 left-0 z-30 h-10 bg-card")}>
                {BUCKET_LABEL[model.bucket]}
              </TableHead>
              {model.columns.map((column) => (
                <TableHead
                  key={column.key}
                  colSpan={tableColumns.length}
                  className="sticky top-0 z-20 h-10 bg-card text-center after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border"
                >
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
            <TableRow>
              <TableHead
                aria-hidden
                className={cn(BUCKET_COL, "sticky top-10 left-0 z-30 h-9 bg-card shadow-[inset_0_-1px_0_0_var(--border)]")}
              />
              {model.columns.flatMap((column) =>
                tableColumns.map((tableColumn) => (
                  <TableHead
                    key={`${column.key}-${tableColumn.key}`}
                    className="sticky top-10 z-20 h-9 min-w-24 bg-card text-right after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-border"
                  >
                    {tableColumn.label}
                  </TableHead>
                ))
              )}
            </TableRow>
          </>
        )}
      </TableHeader>
      <TableBody>
        {model.buckets.map((bucketStart) => (
          <TableRow key={bucketStart}>
            <TableCell className={cn(BUCKET_COL, "sticky left-0 z-10 bg-card tabular-nums")}>
              {bucketStart}
            </TableCell>
            {model.columns.flatMap((column) =>
              tableColumns.map((tableColumn) => {
                return (
                  <TableCell
                    key={`${column.key}-${tableColumn.key}`}
                    className="text-right tabular-nums"
                  >
                    <MetricTableValue
                      column={tableColumn}
                      valueFor={(metricKey) =>
                        column.points.get(metricKey)?.get(bucketStart)
                      }
                      onMetricClick={
                        column.remainder || !onEvidence
                          ? undefined
                          : (metricKey) =>
                              onEvidence(metricKey, column.key, bucketStart)
                      }
                    />
                  </TableCell>
                );
              })
            )}
          </TableRow>
        ))}
      </TableBody>
      <TableFooter className="sticky bottom-0 z-20 bg-muted shadow-[inset_0_1px_0_0_var(--border)]">
        <TableRow>
          <TableCell className={cn(BUCKET_COL, "sticky left-0 z-10 bg-muted")}>
            Total
          </TableCell>
          {model.columns.flatMap((column) =>
            tableColumns.map((tableColumn) => {
              return (
                <TableCell
                  key={`${column.key}-${tableColumn.key}`}
                  className="text-right tabular-nums"
                >
                  <MetricTableValue
                    column={tableColumn}
                    valueFor={(metricKey) => column.totals.get(metricKey)}
                    onMetricClick={
                      column.remainder || !onEvidence
                        ? undefined
                        : (metricKey) => onEvidence(metricKey, column.key, null)
                    }
                  />
                </TableCell>
              );
            })
          )}
        </TableRow>
        {model.dimensions.length > 0 && hasGrandTotal ? (
          <TableRow>
            <TableCell className={cn(BUCKET_COL, "sticky left-0 z-10 bg-muted")}>
              Grand total
            </TableCell>
            <TableCell
              colSpan={model.columns.length * tableColumns.length}
              className="text-left tabular-nums"
            >
              <span className={cn(PAST_BUCKET_COL, "sticky inline-flex flex-wrap items-center gap-1.5")}>
                {tableColumns.map((tableColumn, index) => (
                  <span
                    key={tableColumn.key}
                    className="inline-flex items-center gap-1.5"
                  >
                    {index > 0 ? (
                      <span className="text-muted-foreground">·</span>
                    ) : null}
                    <span>
                      {tableColumn.label}:{" "}
                      <MetricTableValue
                        column={tableColumn}
                        valueFor={(metricKey) => grandTotals.get(metricKey)}
                      />
                    </span>
                  </span>
                ))}
              </span>
            </TableCell>
          </TableRow>
        ) : null}
        </TableFooter>
      </Table>
    </div>
  );
}
