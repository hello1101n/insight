import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Download,
  FileSpreadsheet,
  FileText,
  Search,
} from "lucide-react";

import {
  downloadMetricDrilldown,
  queryMetricDrilldown,
  servesOrderedRows,
  type MetricEvidenceSort,
} from "@/api/metric-drilldown-client";
import { AnalyticsApiError } from "@/api/analytics-client";
import { sessionAuthorizationScope } from "@/auth/session-scope";
import { useAuth } from "@/auth/use-auth";
import type {
  EvidenceDialogState,
  EvidenceDialogTarget,
} from "@/components/metric-evidence-context";
import { MetricEvidencePeople } from "@/components/metric-evidence-people";
import { MetricEvidenceTable } from "@/components/metric-evidence-table";
import { useTypedEvidenceSelection } from "@/queries/metric-definitions";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from "@gears-frontx/ui-kit";
import { formatMetricNumber } from "@/lib/format";
import { useSearchNeedle } from "@/hooks/use-search-needle";
import { nextSort } from "@/lib/metrics/evidence-rows";
import { keepRowsOnReorder } from "@/lib/metrics/evidence-placeholder";
import { retryServerFailureOnce } from "@/queries/retry-server-failure-once";

interface DrillStep {
  target: EvidenceDialogTarget;
  personId: string | null;
}

export function MetricEvidenceDialog({
  state,
  onMetricChange,
  onClose,
}: {
  state: EvidenceDialogState | null;
  onMetricChange: (metricKey: string) => void;
  onClose: () => void;
}) {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  const exportController = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportFailure, setExportFailure] = useState<string | null>(null);
  const records = state?.kind === "records" ? state : null;
  const people = state?.kind === "people" ? state.view : null;
  const [drilled, setDrilled] = useState<DrillStep | null>(null);
  const [peopleSearch, setPeopleSearch] = useState("");
  const [openedState, setOpenedState] = useState(state);
  if (openedState !== state) {
    setOpenedState(state);
    setDrilled(null);
    setPeopleSearch("");
  }
  const activeTarget = people
    ? (drilled?.target ?? null)
    : (records?.targets.find(
        (target) => target.selection.metric_key === records.activeMetricKey
      ) ??
      records?.targets[0] ??
      null);
  const showPeople = people != null && drilled == null;
  const allRecords = people?.allRecords ?? null;
  const headerTitle = drilled
    ? drilled.target.label
    : (people?.title ?? records?.title ?? activeTarget?.label ?? "");
  const selection = useTypedEvidenceSelection(activeTarget?.selection ?? null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<MetricEvidenceSort | null>(null);
  const activeMetricKey = activeTarget?.selection.metric_key ?? null;
  const [scopedTo, setScopedTo] = useState(activeMetricKey);
  if (scopedTo !== activeMetricKey) {
    setScopedTo(activeMetricKey);
    setSearch("");
    setSort(null);
  }
  const needle = useSearchNeedle(search);
  const view = useMemo(
    () => ({
      ...(sort ? { sort } : {}),
      ...(needle === "" ? {} : { search: needle }),
    }),
    [sort, needle]
  );

  const queryKey = ["metric-drilldown", sessionScope, selection, view];
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => {
      if (!selection) throw new Error("Metric evidence selection is missing");
      return queryMetricDrilldown(
        { ...selection, ...view, cursor: pageParam, limit: 100 },
        signal
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepRowsOnReorder(queryKey),
    enabled: sessionScope != null && selection != null,
    retry: retryServerFailureOnce,
  });
  const pages = query.data?.pages;
  const rows = useMemo(
    () => pages?.flatMap((page) => page.rows) ?? [],
    [pages]
  );
  const notReady = pages?.[0]?.not_ready != null;
  const metricLabel = activeTarget?.label;
  const columns = useMemo(() => {
    const columns = query.data?.pages[0]?.columns ?? [];
    const order = new Map([
      ["person", -1],
      ["ref", 0],
      ["title", 1],
      ["value", 1.5],
      ["numerator", 1.5],
      ["denominator", 1.6],
      ["repository", 2],
      ["author", 3],
      ["date", 100],
    ]);
    return [...columns]
      .sort(
        (left, right) =>
          (order.get(left.key) ?? 50) - (order.get(right.key) ?? 50) ||
          left.label.localeCompare(right.label)
      )
      .map((column) =>
        column.key === "value" && metricLabel
          ? { ...column, label: metricLabel }
          : column
      );
  }, [query.data?.pages, metricLabel]);
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const pageLimitReached = (query.data?.pages.length ?? 0) >= 50 && hasNextPage;
  const narrowsRows =
    query.data == null || servesOrderedRows(query.data.pages[0]);
  const shownSort = query.data?.pages[0]?.selection?.sort ?? null;

  const visiblePeople = useMemo(() => {
    const needle = peopleSearch.trim().toLowerCase();
    const rows = people?.rows ?? [];
    return needle === ""
      ? rows
      : rows.filter((row) => row.name.toLowerCase().includes(needle));
  }, [people, peopleSearch]);

  const headingRef = useRef<HTMLSpanElement>(null);
  const focusedStep = useRef(drilled);
  useEffect(() => {
    if (focusedStep.current === drilled) return;
    focusedStep.current = drilled;
    headingRef.current?.focus();
  }, [drilled]);

  useEffect(
    () => () => {
      exportController.current?.abort();
    },
    []
  );

  function resetExport(): void {
    exportController.current?.abort();
    exportController.current = null;
    setExporting(false);
    setExportFailure(null);
  }

  function closeDialog(): void {
    resetExport();
    onClose();
  }

  function goToStep(step: DrillStep | null): void {
    resetExport();
    setDrilled(step);
  }

  async function exportRows(format: "csv" | "xlsx") {
    if (!selection) return;
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportFailure(null);
    try {
      await downloadMetricDrilldown(selection, format, view, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setExportFailure(
          errorMessage(error, "Unable to export metric evidence")
        );
      }
    } finally {
      if (exportController.current === controller) {
        exportController.current = null;
        setExporting(false);
      }
    }
  }

  return (
    <Dialog
      open={state != null}
      onOpenChange={(open) => !open && closeDialog()}
    >
      {state && (activeTarget || showPeople) ? (
        <DialogContent className="flex h-[calc(100dvh-2rem)] max-h-[52rem] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden sm:h-[calc(100dvh-4rem)] sm:w-[calc(100vw-4rem)] sm:max-w-[90rem]">
          <DialogHeader className="shrink-0 pr-14">
            {people && drilled ? (
              <div className="flex">
                <button
                  type="button"
                  onClick={() => goToStep(null)}
                  aria-label={`Back to ${people.title}`}
                  className="-ms-1 flex cursor-pointer items-center gap-1 rounded-sm px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <ArrowLeft className="size-3.5" aria-hidden />
                  {people.title}
                </button>
              </div>
            ) : null}
            <div className="flex min-h-8 items-center justify-between gap-4">
              {records && records.targets.length > 1 && activeTarget ? (
                <>
                  <DialogTitle className="sr-only">
                    {records.title ?? activeTarget.label}
                  </DialogTitle>
                  <Select
                    value={activeTarget.selection.metric_key}
                    onValueChange={(metricKey) => {
                      if (!metricKey) return;
                      resetExport();
                      onMetricChange(metricKey);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Metric"
                    >
                      <SelectValue>{activeTarget.label}</SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start">
                      {records.targets.map((target) => (
                        <SelectItem
                          key={target.selection.metric_key}
                          value={target.selection.metric_key}
                        >
                          {target.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <DialogTitle>
                  <span ref={headingRef} tabIndex={-1} className="outline-none">
                    {headerTitle}
                  </span>
                </DialogTitle>
              )}
              <div className="flex shrink-0 items-center gap-3">
                {drilled?.personId ? (
                  <Link
                    to="/people/$person"
                    params={{ person: drilled.personId }}
                    onClick={closeDialog}
                    className="flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Person page
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  </Link>
                ) : null}
                {showPeople && allRecords ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      goToStep({ target: allRecords, personId: null })
                    }
                  >
                    All records
                  </Button>
                ) : null}
                {showPeople ? null : (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={
                        exporting ||
                        query.isPending ||
                        (query.isError && !query.data)
                      }
                      render={
                        <Button variant="outline" size="sm" icon={<Download />} loading={exporting}>
                          Export
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => void exportRows("csv")}>
                        <FileText />
                        CSV
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void exportRows("xlsx")}>
                        <FileSpreadsheet />
                        Excel
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            </div>
            {exportFailure ? (
              <p role="alert" className="text-sm text-destructive">
                {exportFailure}
              </p>
            ) : null}
            {showPeople && people ? (
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1 sm:max-w-xs">
                  <Input
                    type="search"
                    icon={<Search />}
                    value={peopleSearch}
                    onChange={(event) => setPeopleSearch(event.target.value)}
                    placeholder="Search people"
                    aria-label="Search people"
                  />
                </div>
                <p
                  aria-live="polite"
                  className="text-sm text-muted-foreground tabular-nums"
                >
                  {peopleCount(visiblePeople.length, people.rows.length)}
                </p>
              </div>
            ) : query.isPending || (query.isError && !query.data) ? null : (
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1 sm:max-w-xs">
                  <Input
                    type="search"
                    icon={<Search />}
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search records"
                    aria-label="Search records"
                    disabled={!narrowsRows}
                    title={
                      narrowsRows
                        ? undefined
                        : "Searching records needs a newer server"
                    }
                  />
                </div>
                <p
                  aria-live="polite"
                  className="text-sm text-muted-foreground tabular-nums"
                >
                  {recordCount({
                    loaded: rows.length,
                    filtered: needle !== "",
                    partial: hasNextPage || query.isFetchNextPageError,
                  })}
                </p>
              </div>
            )}
          </DialogHeader>
          {showPeople ? (
            visiblePeople.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <p className="text-sm text-muted-foreground">
                  No people match this search
                </p>
                <Button variant="outline" onClick={() => setPeopleSearch("")}>
                  Clear search
                </Button>
              </div>
            ) : (
              <MetricEvidencePeople
                rows={visiblePeople}
                valueLabel={people.valueLabel}
                onDrill={(row) =>
                  row.target &&
                  goToStep({ target: row.target, personId: row.personId })
                }
              />
            )
          ) : query.isPending ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner size="lg" />
            </div>
          ) : query.isError && !query.data ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3">
              <p role="alert" className="text-sm text-muted-foreground">
                {errorMessage(query.error, "Unable to load metric evidence")}
              </p>
              <Button variant="outline" onClick={() => void query.refetch()}>
                Retry
              </Button>
            </div>
          ) : rows.length === 0 ? (
            notReady ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                No data yet — these records appear once the connector behind
                them has synced.
              </div>
            ) : needle === "" ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                No supporting data for this selection
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3">
                <p className="text-sm text-muted-foreground">
                  No records match this search
                </p>
                <Button variant="outline" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              </div>
            )
          ) : (
            <MetricEvidenceTable
              key={activeMetricKey}
              numbered
              metricKey={activeMetricKey}
              rows={rows}
              columns={columns}
              sort={shownSort}
              onSortChange={(key) =>
                setSort((current) => nextSort(current, key))
              }
              fetchNextPage={fetchNextPage}
              hasNextPage={hasNextPage && !pageLimitReached}
              isFetchingNextPage={isFetchingNextPage}
              reordering={query.isFetching && !isFetchingNextPage}
              nextPageError={query.isFetchNextPageError}
              pageLimitReached={pageLimitReached}
            />
          )}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function recordCount({
  loaded,
  filtered,
  partial,
}: {
  loaded: number;
  filtered: boolean;
  partial: boolean;
}): string {
  const noun = loaded === 1 ? "record" : "records";
  const matching = filtered ? " matching" : "";
  return `${formatMetricNumber(loaded, "integer")}${matching} ${noun}${partial ? " so far" : ""}`;
}

function peopleCount(visible: number, total: number): string {
  const noun = visible === 1 && visible === total ? "person" : "people";
  const count =
    visible === total
      ? formatMetricNumber(visible, "integer")
      : `${formatMetricNumber(visible, "integer")} of ${formatMetricNumber(total, "integer")}`;
  return `${count} ${noun}`;
}

function errorMessage(error: unknown, fallback: string): string {
  if (
    !(error instanceof AnalyticsApiError) ||
    !error.body ||
    typeof error.body !== "object"
  ) {
    return fallback;
  }
  const problem = error.body as { detail?: unknown; trace_id?: unknown };
  const detail = typeof problem.detail === "string" ? problem.detail : fallback;
  return typeof problem.trace_id === "string"
    ? `${detail} Trace: ${problem.trace_id}`
    : detail;
}
