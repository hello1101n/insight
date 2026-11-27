import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { DateRange } from "@/api/period-to-date-range";
import {
  fetchPersonalRecords,
  type PersonalRecordsPage,
} from "@/api/personal-metrics-client";
import { refusal } from "@/components/custom/refusal";
import {
  MetricEvidenceTable,
  type EvidenceMarker,
} from "@/components/metric-evidence-table";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@gears-frontx/ui-kit";
import { drawable } from "@/lib/custom/drilldown";
import { formatRange } from "@/lib/date-range-label";
import {
  CALCULATION_LABEL,
  exclusiveEnd,
  medianRow,
  type PersonalMetricDefinition,
} from "@/lib/portal/personal-metrics";
import { TEXT_BODY, TEXT_FIGURE } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

const MAX_PAGES = 50;
const NO_COLUMNS: PersonalRecordsPage["columns"] = [];

export interface PersonalRecordsTarget {
  metric: PersonalMetricDefinition;
  personId: string;
  personName: string;
  value: string;
}

export function PersonalRecordsDialog({
  target,
  range,
  onClose,
}: {
  target: PersonalRecordsTarget | null;
  range: DateRange;
  onClose: () => void;
}) {
  return (
    <Dialog open={target != null} onOpenChange={(open) => !open && onClose()}>
      {target ? (
        <DialogContent className="flex h-[calc(100dvh-2rem)] max-h-[52rem] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden sm:h-[calc(100dvh-4rem)] sm:w-[calc(100vw-4rem)] sm:max-w-[90rem]">
          <DialogHeader className="shrink-0 pr-14">
            <DialogTitle>{`${target.metric.label} · ${target.personName}`}</DialogTitle>
          </DialogHeader>
          <Records target={target} range={range} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function Records({
  target,
  range,
}: {
  target: PersonalRecordsTarget;
  range: DateRange;
}) {
  const id = target.metric.metric_key.slice("personal.".length);
  const window = exclusiveEnd(range);
  const query = useInfiniteQuery({
    queryKey: [
      "personal-metrics",
      "records",
      id,
      target.personId,
      window.from,
      window.to,
    ],
    queryFn: ({ pageParam }) =>
      fetchPersonalRecords(id, {
        person_id: target.personId,
        from: window.from,
        to: window.to,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });

  const columns = query.data?.pages[0]?.columns ?? NO_COLUMNS;
  const valueKey = query.data?.pages[0]?.value;
  const pages = query.data?.pages;
  const rows = useMemo(
    () =>
      pages?.flatMap((page) => page.rows.map((row) => drawable(row, columns))) ??
      [],
    [pages, columns]
  );
  const marker = useMemo((): EvidenceMarker | undefined => {
    if (!pages || !valueKey) return undefined;
    const row = medianRow(
      pages.flatMap((page) => page.rows.map((record) => record.values[valueKey]))
    );
    return row == null ? undefined : { row, column: valueKey, label: "Median" };
  }, [pages, valueKey]);
  const pageLimitReached =
    (pages?.length ?? 0) >= MAX_PAGES && query.hasNextPage;

  if (query.isPending) return <CenteredSpinner className="min-h-40" />;
  if (query.isError && !query.data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p role="alert" className={cn(TEXT_BODY, "text-destructive")}>
          {refusal(query.error, "The records could not be loaded.")}
        </p>
        <Button variant="outline" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const summary = (
    <Summary
      target={target}
      range={range}
      count={rows.length}
      more={query.hasNextPage}
    />
  );
  if (rows.length === 0) {
    return (
      <>
        {summary}
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No records for this period
        </div>
      </>
    );
  }

  return (
    <>
      {summary}
      <MetricEvidenceTable
        numbered
        metricKey={null}
        rows={rows}
        columns={columns.map((column) => ({ ...column, sortable: false }))}
        sort={null}
        onSortChange={() => undefined}
        fetchNextPage={query.fetchNextPage}
        hasNextPage={query.hasNextPage && !pageLimitReached}
        isFetchingNextPage={query.isFetchingNextPage}
        nextPageError={query.isFetchNextPageError}
        pageLimitReached={pageLimitReached}
        marker={marker}
      />
    </>
  );
}

function Summary({
  target,
  range,
  count,
  more,
}: {
  target: PersonalRecordsTarget;
  range: DateRange;
  count: number;
  more: boolean;
}) {
  const calculation = CALCULATION_LABEL[target.metric.calculation].toLowerCase();
  const noun = count === 1 && !more ? "record" : "records";
  const counted = `${count.toLocaleString("en")}${more ? "+" : ""} ${noun}`;

  return (
    <div className="shrink-0 pt-2 pb-4">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className={TEXT_FIGURE}>{target.value}</span>
        <span className={TEXT_BODY}>{`${calculation} · ${counted}`}</span>
      </p>
      <p className={cn(TEXT_BODY, "text-muted-foreground")}>
        {`${formatRange(range.from, range.to)} · UTC`}
      </p>
    </div>
  );
}
