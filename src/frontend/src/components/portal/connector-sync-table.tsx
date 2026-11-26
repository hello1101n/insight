import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";

import {
  UNMEASURED,
  formatRecords,
  type ConnectorTone,
} from "@/lib/portal/connector-health";
import { activatesRow } from "@/lib/identities/row-activation";
import { cn } from "@/lib/utils";
import { TONE_BADGE } from "./connector-health-tone";
import { ConnectorTimestamp } from "./connector-timestamp";

const RUNS_PER_PAGE = 5;

interface HistoryRow {
  id: string;
  status: { label: string; tone: ConnectorTone };
  started: string | null | undefined;
  duration: string;
  inFlight: boolean;
  records: number | null | undefined;
}

interface HistorySelection {
  selectedId: string;
  detailsId: string;
  inlineDetails?: ReactNode;
  onSelect: (id: string) => void;
}

export function ConnectorSyncTable({
  id,
  rows,
  selection,
}: {
  id: string;
  rows: HistoryRow[];
  selection?: HistorySelection;
}) {
  const { t } = useTranslation();
  const tableViewport = useRef<HTMLDivElement>(null);
  const fullPageHeight = useRef(0);
  const selectedId = selection?.selectedId;
  const [page, setPage] = useState({ index: 0, selectedId });
  const lastPage = Math.max(0, Math.ceil(rows.length / RUNS_PER_PAGE) - 1);
  const selectionChanged = page.selectedId !== selectedId;
  const pageIndex = selectionChanged
    ? Math.floor(
        Math.max(
          0,
          rows.findIndex((row) => row.id === selectedId)
        ) / RUNS_PER_PAGE
      )
    : Math.min(page.index, lastPage);
  if (selectionChanged || page.index !== pageIndex)
    setPage({ index: pageIndex, selectedId });

  const start = pageIndex * RUNS_PER_PAGE;
  const end = Math.min(start + RUNS_PER_PAGE, rows.length);
  const pageRows = rows.slice(start, end);
  const inlineDetails = selection?.inlineDetails;
  const paginated = lastPage > 0;
  const partialPage = paginated && end - start < RUNS_PER_PAGE;

  useLayoutEffect(() => {
    const viewport = tableViewport.current;
    if (!viewport || !paginated) return;
    const table = viewport.querySelector("table");
    if (!table) return;
    const measure = () => {
      const details = table.querySelector(
        "[data-slot=sync-history-details-row]"
      );
      const tableHeight =
        table.getBoundingClientRect().height -
        (details?.getBoundingClientRect().height ?? 0);
      if (partialPage)
        viewport.style.paddingBottom = `${Math.max(0, fullPageHeight.current - tableHeight)}px`;
      else fullPageHeight.current = tableHeight;
    };
    measure();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(table);
    return () => {
      observer?.disconnect();
      viewport.style.removeProperty("padding-bottom");
    };
  }, [paginated, partialPage]);

  return (
    <>
      <div ref={tableViewport} className="min-w-0">
        <Table
          id={id}
          label={t("connectors.history.heading")}
          containerClassName="min-w-0 max-w-full whitespace-normal [overflow-wrap:anywhere]"
          aria-label={t("connectors.history.heading")}
          className="w-full max-w-full table-fixed text-xs sm:text-sm"
        >
          <colgroup>
            <col className="w-[23%] sm:w-1/4" />
            <col className="w-[33%] sm:w-2/5" />
            <col className="w-[23%] sm:w-1/5" />
            <col className="w-[21%] sm:w-[15%]" />
          </colgroup>
          <TableHeader className="[overflow-wrap:anywhere] [word-break:normal] whitespace-normal [&_th]:h-7 [&_th]:py-1">
            <TableRow className="border-b text-left text-muted-foreground">
              <TableHead scope="col" className="px-1 py-2 font-medium">
                {t("common.table.status")}
              </TableHead>
              <TableHead
                scope="col"
                className="px-1 py-2 font-medium whitespace-normal"
              >
                {t("connectors.history.started_utc")}
              </TableHead>
              <TableHead
                scope="col"
                className="px-1 py-2 text-right font-medium"
              >
                {t("connectors.duration")}
              </TableHead>
              <TableHead
                scope="col"
                className="px-1 py-2 text-right font-medium"
              >
                {t("connectors.history.records")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_td]:h-auto [&_td]:py-0.5 sm:[&_td]:py-1">
            {pageRows.map((row) => (
              <Fragment key={row.id}>
                <TableRow
                  data-state={
                    selection?.selectedId === row.id ? "selected" : undefined
                  }
                  className={cn(
                    "border-b last:border-0",
                    selection && "cursor-pointer"
                  )}
                  onClick={
                    selection &&
                    ((event) => {
                      if (activatesRow(event)) selection.onSelect(row.id);
                    })
                  }
                >
                  <TableCell className="px-1 py-2 align-top">
                    <Badge
                      variant={TONE_BADGE[row.status.tone]}
                      className="max-w-full whitespace-normal"
                    >
                      {row.status.label}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-1 py-2 align-top whitespace-normal text-muted-foreground tabular-nums">
                    {selection ? (
                      <button
                        type="button"
                        aria-controls={selection.detailsId}
                        aria-pressed={selection.selectedId === row.id}
                        className="rounded-sm text-start underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground focus-visible:outline-2"
                        onClick={() => selection.onSelect(row.id)}
                      >
                        <ConnectorTimestamp value={row.started} />
                      </button>
                    ) : (
                      <ConnectorTimestamp value={row.started} />
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "px-1 py-2 text-right align-top whitespace-normal tabular-nums",
                      row.inFlight ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {row.duration}
                  </TableCell>
                  <TableCell className="px-1 py-2 text-right align-top [overflow-wrap:anywhere] whitespace-normal text-muted-foreground tabular-nums">
                    {formatRecords(row.records)}
                    {row.records == null && (
                      <span className="sr-only">
                        {t("connectors.history.unmeasured", {
                          value: UNMEASURED,
                        })}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
                {row.id === selectedId && inlineDetails && (
                  <TableRow data-slot="sync-history-details-row">
                    <TableCell colSpan={4} className="px-1 whitespace-normal">
                      {inlineDetails}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
      {paginated && (
        <div className="flex items-center justify-end gap-2">
          <span
            aria-live="polite"
            className="text-xs text-muted-foreground tabular-nums"
          >
            {t("connectors.history.page_range", {
              range: start + 1 === end ? end : `${start + 1}–${end}`,
              total: rows.length,
            })}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="size-7! p-0!"
            aria-label={t("connectors.history.newer_runs")}
            aria-controls={id}
            disabled={pageIndex === 0}
            onClick={() => setPage({ index: pageIndex - 1, selectedId })}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="size-7! p-0!"
            aria-label={t("connectors.history.older_runs")}
            aria-controls={id}
            disabled={pageIndex === lastPage}
            onClick={() => setPage({ index: pageIndex + 1, selectedId })}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      )}
      {inlineDetails &&
        !pageRows.some((row) => row.id === selectedId) &&
        inlineDetails}
    </>
  );
}
