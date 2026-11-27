import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
} from "lucide-react";

import type {
  MetricEvidenceColumn,
  MetricEvidenceRow,
  MetricEvidenceSort,
} from "@/api/metric-drilldown-client";
import { CopyValueButton } from "@/components/copy-value-button";
import { RecordLink } from "@/components/record-link";
import {
  Badge,
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";
import {
  cellText,
  evidenceRowKeys,
  summaryLine,
} from "@/lib/metrics/evidence-rows";
import { fitWidths, type ColumnNeed } from "@/lib/metrics/evidence-widths";
import { evidenceRefText } from "@/lib/metrics/provider-links";
import { formatTimeMetricValue, type MetricValueFormat } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useMetricDefinition } from "@/queries/metric-definitions";

function columnLayout(column: MetricEvidenceColumn) {
  if (column.key === "person") return { basisRem: 11, grow: 0.5 };
  if (column.key === "ref") return { basisRem: 12, grow: 0.5 };
  if (column.key === "title") return { basisRem: 24, grow: 4 };
  if (column.key === "type") return { basisRem: 8, grow: 0 };
  if (column.key === "repository") return { basisRem: 12, grow: 0.5 };
  if (column.key === "author") return { basisRem: 10, grow: 0.25 };
  if (column.key === "destination_branch") return { basisRem: 11, grow: 1 };
  if (column.key === "branch_scope") return { basisRem: 9, grow: 0.25 };
  if (column.key === "date") return { basisRem: 8, grow: 0 };
  if (column.type === "number") return { basisRem: 7, grow: 0 };
  return { basisRem: 9, grow: 1 };
}

const CELL_PADDING_PX = 24;
// WORKAROUND: offsetWidth rounds down, so a measured text can come up a pixel short.
const ROUNDING_PX = 2;
const SORT_ICON_PX = 18;
const COPY_BUTTON_PX = 42;
const MARKER_PX = 20;
const CAP_CHARACTERS = 40;
const MEASURED_ROWS = 100;

const EXPANDER_REM = 2.25;
const NUMBER_REM = 3.5;
const LEADING_REM: readonly number[] = [EXPANDER_REM];
const NUMBERED_LEADING_REM: readonly number[] = [NUMBER_REM, EXPANDER_REM];

const SUMMARY_ONLY_LINKS: ReadonlySet<string> = new Set(["title"]);

export interface EvidenceMarker {
  row: number;
  column: string;
  label: string;
}

function valueText(
  row: MetricEvidenceRow,
  column: MetricEvidenceColumn,
  metric: MetricValueFormat | null
): string {
  const value = row.values[column.key];
  return (
    (column.key === "value" ? formatTimeMetricValue(value, metric) : null) ??
    cellText(value)
  );
}

function cellLine(
  row: MetricEvidenceRow,
  column: MetricEvidenceColumn,
  metricKey: string | null,
  metric: MetricValueFormat | null
): { full: string; line: string } {
  const full = summaryLine(valueText(row, column, metric));
  const line =
    column.key === "ref" ? evidenceRefText(metricKey ?? "", full) : full;
  return { full, line };
}

// WORKAROUND: a canvas measures neither tabular digits nor letter-spacing.
function measureTexts(
  element: HTMLElement,
  texts: readonly { text: string; header: boolean }[]
): number[] {
  const probe = document.createElement("div");
  probe.className =
    "pointer-events-none invisible absolute top-0 left-0 flex flex-col items-start";
  probe.setAttribute("aria-hidden", "true");
  for (const { text, header } of texts) {
    const span = document.createElement("span");
    span.className = header
      ? "font-medium whitespace-nowrap"
      : "tabular-nums whitespace-nowrap";
    span.textContent = text;
    probe.append(span);
  }
  element.append(probe);
  // WORKAROUND: offsetWidth ignores the transform of a dialog still scaling in.
  const widths = [...probe.children].map(
    (child) => (child as HTMLElement).offsetWidth
  );
  probe.remove();
  return widths;
}

function markedLine(
  columns: readonly MetricEvidenceColumn[],
  rows: readonly MetricEvidenceRow[],
  marker: EvidenceMarker | undefined,
  metricKey: string | null,
  metric: MetricValueFormat | null
): string | null {
  const row = marker ? rows[marker.row] : undefined;
  const column = columns.find((candidate) => candidate.key === marker?.column);
  if (!row || !column) return null;

  return cellLine(row, column, metricKey, metric).line;
}

function columnNeeds(
  element: HTMLElement,
  columns: readonly MetricEvidenceColumn[],
  rows: readonly MetricEvidenceRow[],
  metricKey: string | null,
  metric: MetricValueFormat | null,
  marker: EvidenceMarker | undefined
): ColumnNeed[] | null {
  const sample = rows.slice(0, MEASURED_ROWS);
  const marked = markedLine(columns, rows, marker, metricKey, metric);
  const texts = [
    { text: "0".repeat(CAP_CHARACTERS), header: false },
    ...columns.flatMap((column) => [
      { text: column.label, header: true },
      ...sample.map((row) => ({
        text: cellLine(row, column, metricKey, metric).line,
        header: false,
      })),
    ]),
    ...(marked != null && marker
      ? [
          { text: marked, header: false },
          { text: marker.label, header: true },
        ]
      : []),
  ];
  const widths = measureTexts(element, texts);
  if (widths.every((width) => width === 0)) return null;
  const cap = widths[0]!;
  const perColumn = sample.length + 1;
  const markedNeed =
    marked != null
      ? Math.min(widths.at(-2)!, cap) +
        widths.at(-1)! +
        MARKER_PX +
        CELL_PADDING_PX +
        ROUNDING_PX
      : 0;

  return columns.map((column, index) => {
    const start = 1 + index * perColumn;
    const header =
      Math.min(widths[start]!, cap) +
      CELL_PADDING_PX +
      ROUNDING_PX +
      (column.sortable ? SORT_ICON_PX : 0);
    const longest = Math.max(0, ...widths.slice(start + 1, start + perColumn));
    const value =
      Math.min(longest, cap) +
      CELL_PADDING_PX +
      ROUNDING_PX +
      (column.key === "ref" ? COPY_BUTTON_PX : 0);
    const markedValue = column.key === marker?.column ? markedNeed : 0;
    return {
      natural: Math.max(header, value, markedValue),
      stretches: column.type === "string",
    };
  });
}

function CutText({
  full,
  className,
  children,
}: {
  full: string;
  className?: string;
  children: ReactNode;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const text = textRef.current;
        const cut = text !== null && text.scrollWidth > text.clientWidth;
        setOpen(next && (cut || text?.textContent !== full));
      }}
    >
      <TooltipTrigger
        render={<span className={cn("block min-w-0", className)} />}
      >
        <span ref={textRef} className="block truncate">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-md break-words whitespace-pre-wrap">
        {full}
      </TooltipContent>
    </Tooltip>
  );
}

function SortIcon({ state }: { state: "asc" | "desc" | null }) {
  if (state === "asc") return <ArrowUp className="size-3.5 shrink-0" />;
  if (state === "desc") return <ArrowDown className="size-3.5 shrink-0" />;
  return (
    <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/sort:opacity-100" />
  );
}

export function MetricEvidenceTable({
  metricKey,
  rows,
  columns,
  sort,
  onSortChange,
  fetchNextPage,
  hasNextPage,
  isFetchingNextPage,
  reordering,
  nextPageError,
  pageLimitReached,
  numbered = false,
  marker,
}: {
  metricKey: string | null;
  rows: MetricEvidenceRow[];
  columns: MetricEvidenceColumn[];
  sort: MetricEvidenceSort | null;
  onSortChange: (key: string) => void;
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  reordering?: boolean;
  nextPageError: boolean;
  pageLimitReached: boolean;
  numbered?: boolean;
  marker?: EvidenceMarker;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const metric = useMetricDefinition(metricKey);
  const rowKeys = useMemo(() => evidenceRowKeys(rows), [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport,
    estimateSize: () => 44,
    overscan: 8,
    getItemKey: useCallback(
      (index: number) => rowKeys[index] ?? index,
      [rowKeys]
    ),
  });
  const virtualRows = virtualizer.getVirtualItems();
  const virtualBodyHeight = virtualizer.getTotalSize();
  const last = virtualRows.at(-1)?.index ?? 0;
  const leadingRem = numbered ? NUMBERED_LEADING_REM : LEADING_REM;
  const leadingTotalRem = leadingRem.reduce((total, rem) => total + rem, 0);

  useEffect(() => {
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setViewportWidth(entry.contentRect.width);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);

  const measured = useMemo(() => {
    if (!viewport || viewportWidth === 0) return null;
    const needs = columnNeeds(
      viewport,
      columns,
      rows,
      metricKey,
      metric,
      marker
    );
    if (!needs) return null;
    const remPx =
      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return fitWidths(needs, viewportWidth - leadingTotalRem * remPx);
  }, [
    viewport,
    viewportWidth,
    columns,
    rows,
    metricKey,
    metric,
    marker,
    leadingTotalRem,
  ]);

  const minimumWidth = measured
    ? `calc(${leadingTotalRem}rem + ${measured.reduce((total, px) => total + px, 0)}px)`
    : `${columns.reduce(
        (total, column) => total + columnLayout(column).basisRem,
        leadingTotalRem
      )}rem`;
  const gridTemplate = useMemo(() => {
    const tracks = measured
      ? measured.map((px) => `${px.toFixed(1)}px`)
      : columns.map((column) => {
          const { basisRem, grow } = columnLayout(column);
          return grow > 0
            ? `minmax(${basisRem}rem, ${grow}fr)`
            : `${basisRem}rem`;
        });
    const leading = leadingRem.map((rem) => `${rem}rem`);
    return [...leading, ...tracks].join(" ");
  }, [columns, leadingRem, measured]);

  function toggleRow(key: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  useEffect(() => {
    if (
      last >= rows.length - 10 &&
      hasNextPage &&
      !isFetchingNextPage &&
      !nextPageError
    ) {
      void fetchNextPage();
    }
  }, [
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    last,
    nextPageError,
    rows.length,
  ]);

  return (
    <div className="relative min-h-0 flex-1">
      <Table
        role="table"
        aria-busy={reordering ? true : undefined}
        // INVARIANT: ARIA counts the header as row 1, so the data starts at 2.
        aria-rowcount={rows.length + 1}
        containerRef={setViewport}
        containerClassName="h-full overflow-auto"
        className="grid min-w-full"
        style={{
          minWidth: minimumWidth,
          height: virtualBodyHeight + 40,
          gridTemplateRows: "2.5rem 1fr",
        }}
      >
        <TableHeader
          role="rowgroup"
          className="sticky top-0 z-20 grid bg-card"
        >
          <TableRow
            role="row"
            className="grid w-full"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {numbered ? (
              <TableHead
                role="columnheader"
                className="flex items-center justify-end"
              >
                #
              </TableHead>
            ) : null}
            <TableHead
              role="columnheader"
              className="flex items-center"
            >
              <span className="sr-only">Expand record</span>
            </TableHead>
            {columns.map((column) => {
              const state = sort?.key === column.key ? sort.direction : null;
              const numeric = column.type === "number";
              const label = numeric ? (
                <span className="min-w-0 text-right leading-tight whitespace-normal">
                  {column.label}
                </span>
              ) : (
                <CutText full={column.label}>{column.label}</CutText>
              );
              return (
                <TableHead
                  role="columnheader"
                  key={column.key}
                  aria-sort={
                    state === "asc"
                      ? "ascending"
                      : state === "desc"
                        ? "descending"
                        : "none"
                  }
                  className={cn(
                    "flex min-w-0 items-center",
                    numeric
                      ? "justify-end text-right"
                      : "justify-start text-left"
                  )}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSortChange(column.key)}
                      className={cn(
                        "group/sort flex min-w-0 items-center gap-1 rounded-sm [text-transform:inherit] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                        numeric && "flex-row-reverse",
                        state && "text-foreground"
                      )}
                    >
                      {label}
                      <SortIcon state={state} />
                    </button>
                  ) : (
                    label
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody
          role="rowgroup"
          className="relative grid"
          style={{ height: virtualBodyHeight }}
        >
          {virtualRows.map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const key = rowKeys[virtualRow.index]!;
            const isOpen = expanded.has(key);
            const links = row.links ?? {};
            return (
              <TableRow
                role="row"
                key={key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                aria-rowindex={virtualRow.index + 2}
                aria-expanded={isOpen}
                onClick={() => toggleRow(key)}
                className="absolute top-0 left-0 grid w-full cursor-pointer"
                style={{
                  gridTemplateColumns: gridTemplate,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {numbered ? (
                  <TableCell
                    role="cell"
                    className="flex items-center justify-end tabular-nums"
                  >
                    {virtualRow.index + 1}
                  </TableCell>
                ) : null}
                <TableCell
                  role="cell"
                  className="flex items-center justify-center"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-expanded={isOpen}
                    aria-label={
                      isOpen ? "Hide full record" : "Show full record"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleRow(key);
                    }}
                    icon={isOpen ? <ChevronDown /> : <ChevronRight />}
                  />
                </TableCell>
                {columns.map((column) => {
                  const value = row.values[column.key];
                  const { full, line } = cellLine(
                    row,
                    column,
                    metricKey,
                    metric
                  );
                  const marked =
                    marker?.row === virtualRow.index &&
                    marker.column === column.key;
                  return (
                    <TableCell
                      role="cell"
                      key={column.key}
                      className={cn(
                        "flex min-w-0 items-center tabular-nums",
                        column.type === "number" && "justify-end text-right"
                      )}
                    >
                      {column.key === "ref" && value != null ? (
                        <div className="flex min-w-0 items-center gap-1">
                          <CutText full={full}>
                            <RecordLink href={links[column.key]}>
                              {line}
                            </RecordLink>
                          </CutText>
                          <CopyValueButton
                            value={String(value)}
                            title="Copy ref"
                            errorMessage="Unable to copy ref"
                          />
                        </div>
                      ) : marked ? (
                        <div
                          className={cn(
                            "flex min-w-0 items-center gap-1.5",
                            column.type === "number" && "flex-row-reverse"
                          )}
                        >
                          <CutText full={full}>
                            <strong className="font-semibold">
                              <RecordLink href={links[column.key]}>
                                {line}
                              </RecordLink>
                            </strong>
                          </CutText>
                          <Badge variant="secondary" size="xs">
                            {marker.label}
                          </Badge>
                        </div>
                      ) : (
                        <CutText full={full}>
                          <RecordLink href={links[column.key]}>
                            {line}
                          </RecordLink>
                        </CutText>
                      )}
                    </TableCell>
                  );
                })}
                {isOpen ? (
                  <TableCell
                    role="cell"
                    aria-colspan={leadingRem.length + columns.length}
                    // INVARIANT: selecting text here must not reach the row's
                    // expand toggle.
                    onClick={(event) => event.stopPropagation()}
                    className="h-auto cursor-auto"
                    style={{ gridColumn: "1 / -1" }}
                  >
                    {/* INVARIANT: a fixed cap, not a vh — the window can
                      exceed the table's own height. */}
                    <dl className="grid max-h-96 gap-x-6 gap-y-2 overflow-y-auto overscroll-contain sm:grid-cols-[10rem_1fr]">
                      {columns.map((column) => {
                        const text = valueText(row, column, metric);
                        return (
                          <Fragment key={column.key}>
                            <dt className="text-sm text-muted-foreground">
                              {column.label}
                            </dt>
                            <dd className="text-sm break-words whitespace-pre-wrap">
                              <RecordLink
                                href={
                                  SUMMARY_ONLY_LINKS.has(column.key)
                                    ? undefined
                                    : links[column.key]
                                }
                              >
                                {text}
                              </RecordLink>
                            </dd>
                          </Fragment>
                        );
                      })}
                    </dl>
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {isFetchingNextPage || reordering ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-card/80 p-3">
          <Spinner />
        </div>
      ) : null}
      {nextPageError ? (
        <div
          role="alert"
          className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 border-t bg-card p-3"
        >
          <span>Unable to load more rows</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void fetchNextPage()}
          >
            Retry
          </Button>
        </div>
      ) : pageLimitReached ? (
        <div className="absolute inset-x-0 bottom-0 border-t bg-card p-3 text-center text-sm text-muted-foreground">
          Showing the first 5,000 rows. Refine the selection or export the
          full result.
        </div>
      ) : null}
    </div>
  );
}
