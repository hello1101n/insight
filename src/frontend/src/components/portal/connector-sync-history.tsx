import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { useId, type ReactNode } from "react";

import type {
  ConnectorHealth,
  ConnectorInstanceRef,
  ConnectorSyncHistory as SyncHistoryData,
  SyncFact,
} from "@/api/connector-health-client";
import {
  Card,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@gears-frontx/ui-kit";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { ConnectorRunHistory } from "./connector-run-history";
import { ConnectorRunSummary } from "./connector-run-summary";
import { ConnectorSyncTable } from "./connector-sync-table";
import { historySegmentStyle } from "./connector-health-tone";
import { ConnectorScheduleTooltip } from "./connector-schedule-tooltip";
import {
  describeDuration,
  describeSync,
  formatStarted,
} from "@/lib/portal/connector-health";
import { projectRun } from "@/lib/portal/connector-runs";
import { cn } from "@/lib/utils";
import { useConnectorSyncs } from "@/queries/connector-health";

const MAX_RUNS = 50;

function statusTotals(syncs: readonly SyncFact[]) {
  const finished = syncs.filter((sync) =>
    ["succeeded", "failed", "cancelled", "incomplete"].includes(sync.status)
  );
  if (!finished.length) return null;

  const succeeded = finished.filter(
    (sync) => sync.status === "succeeded"
  ).length;
  const percent = Math.round((succeeded / finished.length) * 100);
  return {
    share: i18n.t("connectors.history.succeeded_share", { percent }),
    counts: i18n.t("connectors.history.succeeded_counts", {
      succeeded,
      total: finished.length,
      failed: finished.length - succeeded,
    }),
  };
}

export function ConnectorSyncHistory({
  instance,
  asOf,
  schedule,
}: {
  instance: ConnectorInstanceRef &
    Pick<ConnectorHealth, "latest_run" | "last_successful_run">;
  asOf: string;
  schedule?: ReactNode;
}) {
  const { data, isPending, isError, refetch } = useConnectorSyncs(instance);
  let history: ReactNode;
  let summary: ReactNode;

  if (isPending) {
    history = <CenteredSpinner className="min-h-24" />;
  } else if (isError || data === undefined) {
    history = (
      <div className="max-w-md">
        <ComingSoon variant="card" state="error" onRetry={() => refetch()} />
      </div>
    );
  } else if (
    !data.history_read_error &&
    (instance.latest_run ||
      (data.runs && (data.runs.length > 0 || data.syncs.length === 0)))
  ) {
    const recent = instance.latest_run && projectRun(instance.latest_run);
    const recordedSuccess =
      instance.last_successful_run && projectRun(instance.last_successful_run);
    const runs = (data.runs ?? []).map(projectRun);
    if (recent && !runs.some((run) => run.sync_id === recent.sync_id))
      runs.unshift(recent);
    const newestSuccess = runs.find((run) => run.status === "succeeded");
    const successful =
      newestSuccess &&
      (!recordedSuccess ||
        Date.parse(newestSuccess.started_at) >
          Date.parse(recordedSuccess.started_at))
        ? newestSuccess
        : recordedSuccess;

    summary = (
      <ConnectorRunSummary
        current={recent ?? runs[0]}
        successful={successful}
        asOf={asOf}
        className={
          schedule ? "divide-y border-t pt-1" : "mb-2 divide-y border-b"
        }
      />
    );
    history = (
      <ConnectorRunHistory
        runs={runs}
        syncs={data.syncs}
        limit={MAX_RUNS}
        asOf={asOf}
      />
    );
  } else {
    history = <SyncFactsHistory data={data} asOf={asOf} />;
  }

  return (
    <div
      className={cn(
        "sticky left-4 grid w-[calc(100cqw-2rem)] max-w-full min-w-0 grid-cols-1 items-start gap-2 py-1 [overflow-wrap:anywhere] whitespace-normal sm:py-2",
        schedule &&
          "@min-[58rem]:my-2 @min-[58rem]:grid-cols-[clamp(19rem,24%,26rem)_minmax(0,1fr)] @min-[58rem]:items-stretch @min-[58rem]:gap-0 @min-[58rem]:rounded-lg @min-[58rem]:border @min-[58rem]:bg-card @min-[58rem]:py-0"
      )}
    >
      {schedule && (
        <Card
          size="sm"
          className="@container min-w-0 gap-3 px-3 py-2 @min-[58rem]:rounded-none @min-[58rem]:border-0 @min-[58rem]:border-r @min-[58rem]:bg-muted/40 @min-[58rem]:p-4 @min-[58rem]:shadow-none"
        >
          {schedule}
          {summary}
        </Card>
      )}
      <Card
        size="sm"
        className={cn(
          "min-w-0 p-2 sm:p-3",
          schedule &&
            "@min-[58rem]:rounded-none @min-[58rem]:border-0 @min-[58rem]:bg-transparent @min-[58rem]:p-4 @min-[58rem]:shadow-none"
        )}
      >
        {!schedule && summary}
        {history}
      </Card>
    </div>
  );
}

function SyncFactsHistory({
  data,
  asOf,
}: {
  data: SyncHistoryData;
  asOf: string;
}) {
  const { t } = useTranslation();
  const id = useId();
  const syncs = data.syncs.slice(0, MAX_RUNS);
  const totals = statusTotals(syncs);
  const count = t("connectors.history.latest", { count: syncs.length });

  return (
    <section
      aria-labelledby={syncs.length ? undefined : `${id}-heading`}
      className="max-w-full min-w-0 space-y-3 [overflow-wrap:anywhere] whitespace-normal"
    >
      {data.history_read_error && (
        <p role="alert" className="text-sm text-warning">
          {data.history_read_error}
        </p>
      )}
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id={`${id}-heading`} className="shrink-0 text-sm font-semibold">
          {t("connectors.history.heading")}
        </h3>
        {syncs.length > 0 && (
          <>
            <ol
              aria-label={t("connectors.history.statuses_label")}
              className="grid w-full min-w-0"
              style={{
                gridTemplateColumns: `repeat(${MAX_RUNS}, minmax(0, 1fr))`,
              }}
            >
              {syncs
                .slice()
                .reverse()
                .map((sync, index) => {
                  const state = describeSync(sync);
                  const label = t("connectors.history.run_label", {
                    index: syncs.length - index,
                    state: state.label,
                    started: formatStarted(sync.started_at),
                  });
                  return (
                    <Tooltip key={sync.job_id}>
                      <TooltipTrigger
                        render={<li />}
                        role="listitem"
                        tabIndex={-1}
                        aria-label={label}
                        className={cn(
                          "h-3 min-w-0 border-background/50 not-last:border-r first:rounded-l-full last:rounded-r-full",
                          historySegmentStyle(sync.status, state.tone)
                        )}
                      />
                      <TooltipContent role="tooltip">{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
            </ol>
            {totals && (
              <ConnectorScheduleTooltip lines={[totals.counts]}>
                <span className="text-xs text-muted-foreground">
                  {totals.share}
                </span>
              </ConnectorScheduleTooltip>
            )}
          </>
        )}
        {syncs.length > 0 && (
          <p className="ml-auto text-xs text-muted-foreground">{count}</p>
        )}
      </div>
      {syncs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("connectors.history.empty")}
        </p>
      ) : (
        <ConnectorSyncTable
          id={`${id}-table`}
          rows={syncs.map((sync) => {
            const state = describeSync(sync);
            const duration = describeDuration(sync, asOf);
            return {
              id: sync.job_id,
              status: state,
              started: sync.started_at,
              duration: duration.text,
              inFlight: duration.inFlight,
              records: sync.records_reported,
            };
          })}
        />
      )}
    </section>
  );
}
