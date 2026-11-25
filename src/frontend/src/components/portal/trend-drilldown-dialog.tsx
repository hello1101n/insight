import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import {
  MAX_EVIDENCE_PERSONS,
  personsEvidenceSelection,
  queryMetricDrilldown,
  type MetricEvidenceSort,
} from "@/api/metric-drilldown-client";
import { sessionAuthorizationScope } from "@/auth/session-scope";
import { useAuth } from "@/auth/use-auth";
import { MetricEvidenceTable } from "@/components/metric-evidence-table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";
import { formatMetricNumber, formatTimeMetricValue } from "@/lib/format";
import { nextSort } from "@/lib/metrics/evidence-rows";
import { keepRowsOnReorder } from "@/lib/metrics/evidence-placeholder";
import { type BucketBreakdownRow } from "@/lib/portal/trend-drilldown";
import { useMetricDefinition } from "@/queries/metric-definitions";
import { retryServerFailureOnce } from "@/queries/retry-server-failure-once";

const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

export interface TrendDrilldownState {
  metricKey: string | null;
  label: string;
  bucketLabel: string;
  period: { from: string; to: string };
  members: readonly { person_id: string; name: string }[];
  breakdown: BucketBreakdownRow[];
}

export function TrendDrilldownDialog({
  state,
  onClose,
}: {
  state: TrendDrilldownState | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={state != null} onOpenChange={(open) => !open && onClose()}>
      {state ? (
        <DialogContent className="flex h-[calc(100dvh-4rem)] max-h-[52rem] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden sm:max-w-[76rem]">
          <DialogHeader className="shrink-0">
            <DialogTitle>{state.label}</DialogTitle>
            <p className="text-muted-foreground text-sm">
              {state.members.length}{" "}
              {state.members.length === 1 ? "person" : "people"} ·{" "}
              {state.period.from} – {state.period.to}
            </p>
          </DialogHeader>
          <Body state={state} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function Body({ state }: { state: TrendDrilldownState }) {
  if (!state.metricKey) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <PeriodTable state={state} />
      </div>
    );
  }

  return (
    <Tabs defaultValue="records" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="mx-5 mt-4 self-start">
        <TabsTrigger value="records">Records</TabsTrigger>
        <TabsTrigger value="periods">By {state.bucketLabel}</TabsTrigger>
      </TabsList>
      <TabsContent value="records" className="min-h-0 flex-1 overflow-hidden">
        <Records metricKey={state.metricKey} state={state} />
      </TabsContent>
      <TabsContent value="periods" className="min-h-0 flex-1 overflow-auto p-5">
        <PeriodTable state={state} />
      </TabsContent>
    </Tabs>
  );
}

function Records({
  metricKey,
  state,
}: {
  metricKey: string;
  state: TrendDrilldownState;
}) {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  const [sort, setSort] = useState<MetricEvidenceSort | null>(null);

  const selection = useMemo(
    () =>
      personsEvidenceSelection(
        { metric_key: metricKey, period: state.period, filters: [] },
        state.members.map((member) => member.person_id),
        state.period,
      ),
    [metricKey, state.members, state.period],
  );
  const view = useMemo(() => (sort ? { sort } : {}), [sort]);
  const queryKey = ["metric-drilldown", "trend", sessionScope, selection, view];
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => {
      if (!selection) throw new Error("Metric evidence selection is missing");
      return queryMetricDrilldown(
        { ...selection, ...view, cursor: pageParam, limit: PAGE_LIMIT },
        signal,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    placeholderData: keepRowsOnReorder(queryKey),
    enabled: sessionScope != null && selection != null,
    retry: retryServerFailureOnce,
  });

  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.rows) ?? [],
    [query.data],
  );
  const columns = query.data?.pages[0]?.columns ?? [];
  const shownSort = query.data?.pages[0]?.selection?.sort ?? null;
  const pageLimitReached =
    (query.data?.pages.length ?? 0) >= MAX_PAGES && query.hasNextPage;

  if (!state.members.length) {
    return (
      <p className="text-muted-foreground p-5 text-sm">
        No records in this window.
      </p>
    );
  }

  if (!selection) {
    return (
      <p className="text-muted-foreground p-5 text-sm">
        This scope holds more than {MAX_EVIDENCE_PERSONS} people, which is more
        than one table can stand behind. Narrow it and open the chart again.
      </p>
    );
  }

  if (query.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (query.isError && !query.data) {
    return (
      <p className="text-muted-foreground p-5 text-sm" role="alert">
        These records could not be read, so nothing is claimed here. Try again
        in a moment.
      </p>
    );
  }

  if (query.data?.pages[0]?.not_ready) {
    return (
      <p className="text-muted-foreground p-5 text-sm">
        No data yet — these records appear once the connector behind them has
        synced.
      </p>
    );
  }

  if (!rows.length) {
    return (
      <p className="text-muted-foreground p-5 text-sm">
        No records in this window.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <MetricEvidenceTable
        numbered
        metricKey={metricKey}
        rows={rows}
        columns={columns}
        sort={shownSort}
        onSortChange={(key) => setSort((current) => nextSort(current, key))}
        fetchNextPage={query.fetchNextPage}
        hasNextPage={query.hasNextPage && !pageLimitReached}
        isFetchingNextPage={query.isFetchingNextPage}
        reordering={query.isFetching && !query.isFetchingNextPage}
        nextPageError={query.isFetchNextPageError}
        pageLimitReached={pageLimitReached}
      />
    </div>
  );
}

function PeriodTable({ state }: { state: TrendDrilldownState }) {
  const metric = useMetricDefinition(state.metricKey);
  if (!state.breakdown.length) {
    return (
      <p className="text-muted-foreground text-sm">
        No readings in this window.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-36 whitespace-nowrap">
            {state.bucketLabel}
          </TableHead>
          <TableHead className="w-28 text-right whitespace-nowrap">
            Total
          </TableHead>
          <TableHead className="w-28 text-right whitespace-nowrap">
            Active
          </TableHead>
          <TableHead>Who</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {state.breakdown.map((row) => (
          <TableRow key={row.date}>
            <TableCell className="whitespace-nowrap tabular-nums">
              {row.date}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap tabular-nums">
              {formatTimeMetricValue(row.total, metric) ??
                formatMetricNumber(row.total, "decimal")}
            </TableCell>
            <TableCell className="text-right whitespace-nowrap tabular-nums">
              {row.contributors.length}
            </TableCell>
            <TableCell>
              {row.contributors.length ? row.contributors.join(", ") : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
