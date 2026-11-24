import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { DateRange } from "@/api/period-to-date-range";
import {
  fetchPersonalRecords,
  type PersonalRecordsPage,
} from "@/api/personal-metrics-client";
import { refusal } from "@/components/custom/refusal";
import { MetricEvidenceTable } from "@/components/metric-evidence-table";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@gears-frontx/ui-kit";
import { drawable } from "@/lib/custom/drilldown";
import {
  exclusiveEnd,
  type PersonalMetricDefinition,
} from "@/lib/portal/personal-metrics";
import { TEXT_BODY } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

const MAX_PAGES = 50;
const NO_COLUMNS: PersonalRecordsPage["columns"] = [];

export interface PersonalRecordsTarget {
  metric: PersonalMetricDefinition;
  personId: string;
  personName: string;
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
  const pages = query.data?.pages;
  const rows = useMemo(
    () =>
      pages?.flatMap((page) => page.rows.map((row) => drawable(row, columns))) ??
      [],
    [pages, columns]
  );
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
  if (rows.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No records for this period
      </div>
    );
  }

  return (
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
    />
  );
}
