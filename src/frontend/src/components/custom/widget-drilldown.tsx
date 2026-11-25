import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Maximize2, Minimize2 } from "lucide-react";

import type { DrilldownSort, Widget } from "@/api/custom-client";
import { MetricName } from "@/components/custom/metric-name";
import { refusal } from "@/components/custom/refusal";
import { MetricEvidenceTable } from "@/components/metric-evidence-table";
import {
  MetricSummary,
  WidgetSummary,
} from "@/components/custom/definition-summary";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@gears-frontx/ui-kit";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { drawable, refusedForRebuiltSource } from "@/lib/custom/drilldown";
import { nextSort } from "@/lib/metrics/evidence-rows";
import { drilldownPagesQuery, metricQuery } from "@/queries/custom";
import type { RunOptions } from "@/api/custom-client";
import { TEXT_BODY, TEXT_LABEL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

type View =
  { kind: "rows" } | { kind: "widget" } | { kind: "metric"; id: string };

const BESIDE_KIT_CLOSE_BUTTON = "absolute top-4 right-14";

export function WidgetDrilldown({
  dashboard,
  widgetId,
  widget,
  name,
  label,
  open,
  onOpenChange,
  options,
}: {
  dashboard: string;
  widgetId: string;
  widget: Widget;
  name: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options?: RunOptions;
}) {
  const [view, setView] = useState<View>({ kind: "rows" });
  const [filling, setFilling] = useState(false);

  function change(next: boolean) {
    if (!next) {
      setView({ kind: "rows" });
      setFilling(false);
    }
    onOpenChange(next);
  }

  const heading =
    view.kind === "rows" ? (
      label
    ) : view.kind === "widget" ? (
      name
    ) : (
      <MetricName id={view.id} />
    );

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent
        className={cn(
          filling
            ? "h-[96vh] w-[98vw] max-w-[98vw] content-start"
            : "w-[min(96vw,80rem)] max-w-[min(96vw,80rem)]"
        )}
      >
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            {view.kind === "rows" ? null : (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Back to the rows"
                onClick={() => setView({ kind: "rows" })}
                icon={<ArrowLeft />}
              />
            )}
            <span className="min-w-0 truncate">{heading}</span>
            <Button
              variant="ghost"
              className={cn(BESIDE_KIT_CLOSE_BUTTON, "z-[2] w-9")}
              aria-pressed={filling}
              aria-label={
                filling ? "Shrink the dialog back" : "Fill the window"
              }
              onClick={() => setFilling((was) => !was)}
              icon={filling ? <Minimize2 /> : <Maximize2 />}
            />
          </DialogTitle>
          {view.kind === "rows" ? null : (
            <DialogDescription>
              {view.kind === "widget"
                ? "The widget, as it is stored."
                : "The metric, as it is stored."}
            </DialogDescription>
          )}
        </DialogHeader>

        {open && view.kind === "rows" ? (
          <>
            <Rows
              dashboard={dashboard}
              widgetId={widgetId}
              metric={widget.detail ?? widget.metric}
              options={options}
              filling={filling}
            />
            <Definitions widget={widget} name={name} onOpen={setView} />
          </>
        ) : null}
        {view.kind === "widget" ? (
          <WidgetSummary widget={widget} linkMetric={false} />
        ) : null}
        {view.kind === "metric" ? <StoredMetric id={view.id} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Definitions({
  widget,
  name,
  onOpen,
}: {
  widget: Widget;
  name: string;
  onOpen: (view: View) => void;
}) {
  const metrics = [widget.metric, widget.detail].filter(
    (metric, index, all): metric is string =>
      Boolean(metric) && all.indexOf(metric) === index
  );

  return (
    <div
      className={cn(TEXT_LABEL, "flex flex-wrap items-center gap-x-4 gap-y-1")}
    >
      <span className="flex items-center gap-1">
        Widget
        <DefinitionButton onClick={() => onOpen({ kind: "widget" })}>
          {name}
        </DefinitionButton>
      </span>
      <span className="flex items-center gap-1">
        {metrics.length > 1 ? "Metrics" : "Metric"}
        {metrics.map((metric) => (
          <DefinitionButton
            key={metric}
            onClick={() => onOpen({ kind: "metric", id: metric })}
          >
            <MetricName id={metric} />
          </DefinitionButton>
        ))}
      </span>
    </div>
  );
}

function DefinitionButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="underline decoration-dotted underline-offset-4"
    >
      {children}
    </button>
  );
}

function StoredMetric({ id }: { id: string }) {
  const definition = useQuery(metricQuery(id));

  if (definition.isPending) return <CenteredSpinner className="min-h-40" />;
  if (definition.isError || !definition.data) {
    return (
      <p role="alert" className={cn(TEXT_BODY, "text-destructive")}>
        {refusal(definition.error, "That metric is not there.")}
      </p>
    );
  }

  return <MetricSummary definition={definition.data.definition} />;
}

const MAX_PAGES = 50;

function Rows({
  dashboard,
  widgetId,
  metric,
  options,
  filling,
}: {
  dashboard: string;
  widgetId: string;
  metric: string;
  options?: RunOptions;
  filling: boolean;
}) {
  const definition = useQuery(metricQuery(metric));
  const [sort, setSort] = useState<DrilldownSort | null>(null);

  const windowed = options && Boolean(definition.data?.clock);
  const pages = useInfiniteQuery({
    ...drilldownPagesQuery(dashboard, widgetId, {
      ...(windowed ? options : {}),
      ...(sort ? { sort } : {}),
    }),
    enabled: definition.isSuccess,
  });

  const columns = useMemo(
    () => pages.data?.pages[0]?.columns ?? [],
    [pages.data]
  );
  const rows = useMemo(
    () =>
      pages.data?.pages.flatMap((page) =>
        page.rows.map((row) => drawable(row, columns))
      ) ?? [],
    [pages.data, columns]
  );
  const shownSort = pages.data?.pages[0]?.selection.sort ?? null;
  const pageLimitReached =
    (pages.data?.pages.length ?? 0) >= MAX_PAGES && pages.hasNextPage;

  if (definition.isError) {
    return (
      <p role="alert" className={cn(TEXT_BODY, "text-destructive")}>
        {refusal(definition.error, "That metric is not there.")}
      </p>
    );
  }
  if (definition.isPending || pages.isPending)
    return <CenteredSpinner className="min-h-40" />;
  if (pages.isError && !pages.data) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className={cn(TEXT_BODY, "text-destructive")}>
          {refusal(pages.error, "The metric could not be run.")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void pages.refetch()}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (rows.length === 0 && !pages.isFetching) {
    return <p className={TEXT_BODY}>No data.</p>;
  }

  return (
    <div
      className={cn(
        "relative flex min-w-0 flex-col",
        filling ? "h-[calc(96vh-11rem)]" : "h-[60vh]"
      )}
    >
      <MetricEvidenceTable
        metricKey={null}
        rows={rows}
        columns={columns}
        sort={shownSort}
        onSortChange={(key) => setSort(nextSort(shownSort, key))}
        fetchNextPage={() =>
          refusedForRebuiltSource(pages.error)
            ? pages.refetch()
            : pages.fetchNextPage()
        }
        hasNextPage={pages.hasNextPage && !pageLimitReached}
        isFetchingNextPage={pages.isFetchingNextPage}
        reordering={pages.isFetching && !pages.isFetchingNextPage}
        nextPageError={pages.isFetchNextPageError}
        pageLimitReached={pageLimitReached}
        numbered
      />
    </div>
  );
}
