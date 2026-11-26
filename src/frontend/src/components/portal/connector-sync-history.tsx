import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { useId, useState } from "react";

import type {
  ConnectorHealth,
  ConnectorInstanceRef,
  SyncFact,
} from "@/api/connector-health-client";
import { Tooltip, TooltipContent, TooltipTrigger } from "@gears-frontx/ui-kit";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { ConnectorRunHistory } from "./connector-run-history";
import {
  ConnectorSyncTable,
  ConnectorSyncTableToggle,
  INITIAL_HISTORY_ROWS,
} from "./connector-sync-table";
import { historySegmentStyle } from "./connector-health-tone";
import { ConnectorScheduleTooltip } from "./connector-schedule-tooltip";
import {
  describeDuration,
  describeSync,
  formatStarted,
} from "@/lib/portal/connector-health";
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
}: {
  instance: ConnectorInstanceRef &
    Pick<ConnectorHealth, "latest_run" | "last_successful_run">;
  asOf: string;
}) {
  const { t } = useTranslation();
  const { data, isPending, isError, refetch } = useConnectorSyncs(instance);
  const [showAll, setShowAll] = useState(false);
  const id = useId();

  if (isPending) return <CenteredSpinner className="min-h-24" />;
  if (isError || data === undefined) {
    return (
      <div className="max-w-md">
        <ComingSoon variant="card" state="error" onRetry={() => refetch()} />
      </div>
    );
  }

  if (
    !data.history_read_error &&
    (instance.latest_run ||
      (data.runs && (data.runs.length > 0 || data.syncs.length === 0)))
  ) {
    return (
      <ConnectorRunHistory
        latest={instance.latest_run}
        lastSuccess={instance.last_successful_run}
        runs={data.runs ?? []}
        syncs={data.syncs}
        limit={MAX_RUNS}
        asOf={asOf}
      />
    );
  }

  const syncs = data.syncs.slice(0, MAX_RUNS);
  const totals = statusTotals(syncs);
  const visible = showAll ? syncs : syncs.slice(0, INITIAL_HISTORY_ROWS);
  const count =
    syncs.length > visible.length
      ? t("connectors.history.latest_recorded", {
          shown: visible.length,
          total: syncs.length,
        })
      : t("connectors.history.latest", { count: syncs.length });

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
        <p className="ml-auto text-xs text-muted-foreground">{count}</p>
      </div>
      {syncs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("connectors.history.empty")}
        </p>
      ) : (
        <>
          <ConnectorSyncTable
            id={`${id}-table`}
            rows={visible.map((sync) => {
              const state = describeSync(sync);
              const duration = describeDuration(sync, asOf);
              return {
                id: sync.job_id,
                status: state,
                started: formatStarted(sync.started_at),
                duration: duration.text,
                inFlight: duration.inFlight,
                records: sync.records_reported,
              };
            })}
          />
          <ConnectorSyncTableToggle
            tableId={`${id}-table`}
            count={syncs.length}
            showAll={showAll}
            onToggle={() => setShowAll(!showAll)}
          />
        </>
      )}
    </section>
  );
}
