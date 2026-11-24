import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  ConnectorHealth,
  ConnectorInstanceRef,
} from "@/api/connector-health-client";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import {
  Badge,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";
import { ConnectorSchedulePane } from "@/components/portal/connector-schedule-pane";
import { ConnectorSyncHistory } from "./connector-sync-history";
import { TONE_BADGE } from "./connector-health-tone";
import { ConnectorScheduleRequestChip } from "@/components/portal/connector-schedule-request-chip";
import {
  UNMEASURED,
  describeConnector,
  describeDuration,
  describeInstance,
  describeNextRun,
  describeRecording,
  describeSchedule,
  formatRecords,
  formatStarted,
  instanceKey,
} from "@/lib/portal/connector-health";
import { useConnectorHealth } from "@/queries/connector-health";
import {
  activatesRow,
  activatesRowByKey,
} from "@/lib/identities/row-activation";
import { cn } from "@/lib/utils";

const COLUMNS = 7;

function panelIdFor(row: ConnectorHealth): string {
  const id = instanceKey(row).replaceAll("_", "%5F").replaceAll("/", "_");
  return `connector-syncs-${id}`;
}

export function ConnectorHealthPane() {
  const { t } = useTranslation();
  const { data, isPending, isError, refetch } = useConnectorHealth();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isPending)
    return (
      <CenteredSpinner
        data-testid="page-manage-connector-health"
        className="min-h-[60vh]"
      />
    );
  if (isError || data === undefined) {
    return (
      <div
        data-testid="page-manage-connector-health"
        className="mx-auto w-full max-w-md p-8"
      >
        <ComingSoon variant="card" state="error" onRetry={() => refetch()} />
      </div>
    );
  }

  const recording = describeRecording(data);
  const polling = data.connectors.some(
    (row) => row.schedule_request?.last_observation?.status === "pending"
  );

  return (
    <div
      data-testid="page-manage-connector-health"
      className="flex min-w-0 flex-col gap-3 p-4 md:p-6"
    >
      <div>
        <h1 className="text-lg font-semibold tracking-tight">
          {t("connectors.title")}
        </h1>
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "text-sm",
            recording.state === "stopped" || recording.state === "unreadable"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          <p>{recording.label}</p>
          {recording.detail !== "" && <p>{recording.detail}</p>}
        </div>
      </div>

      {data.schedule_read_error && (
        <p role="alert" className="text-sm text-warning">
          {data.schedule_read_error}
        </p>
      )}
      {data.connectors.length === 0 ? (
        <div className="rounded-lg border p-6 text-sm text-muted-foreground">
          {recording.state === "never_read"
            ? t("connectors.empty_never_read")
            : t("connectors.empty_recorded")}
        </div>
      ) : (
        <div className="max-w-full min-w-0 overflow-x-auto rounded-lg border">
          <Table containerClassName="@container">
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-normal">
                  {t("connectors.connector")}
                </TableHead>
                <TableHead className="whitespace-normal">
                  {t("connectors.instance")}
                </TableHead>
                <TableHead className="whitespace-normal">
                  {t("connectors.next_sync")}
                </TableHead>
                <TableHead className="whitespace-normal">
                  {t("connectors.state")}
                </TableHead>
                <TableHead className="whitespace-normal">
                  {t("connectors.last_sync_started")}
                </TableHead>
                <TableHead className="text-right whitespace-normal">
                  {t("connectors.duration")}
                </TableHead>
                <TableHead className="text-right whitespace-normal">
                  {t("connectors.records_reported")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.connectors.map((row) => {
                const state = describeConnector(row);
                const key = instanceKey(row);
                const open = expanded === key;
                const panelId = panelIdFor(row);
                const toggle = () => setExpanded(open ? null : key);
                return [
                  <TableRow
                    key={key}
                    data-state-name={state.state}
                    data-state={open ? "selected" : undefined}
                    tabIndex={0}
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={(event) => {
                      if (activatesRow(event)) toggle();
                    }}
                    onKeyDown={(event) => {
                      if (!activatesRowByKey(event)) return;
                      event.preventDefault();
                      toggle();
                    }}
                    className="cursor-pointer select-text"
                  >
                    <TableCell>
                      {row.connector}
                    </TableCell>
                    <InstanceCell instance={row} />
                    <ScheduleCell row={row} />
                    <TableCell>
                      <Badge variant={TONE_BADGE[state.tone]}>
                        {state.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatStarted(row.last_sync?.started_at ?? null)}
                    </TableCell>
                    <DurationCell sync={row.last_sync} asOf={data.as_of} />
                    <TableCell className="text-right tabular-nums">
                      {formatRecords(row.last_sync?.records_reported ?? null)}
                    </TableCell>
                  </TableRow>,
                  open ? (
                    <TableRow key={`syncs-${key}`}>
                      <TableCell
                        colSpan={COLUMNS}
                        id={panelId}
                        className="whitespace-normal"
                      >
                        <div className="min-w-0 [contain:inline-size]">
                          <div className="sticky left-4 grid w-[calc(100cqw-2rem)] max-w-full min-w-0 grid-cols-1 gap-4 py-2 [overflow-wrap:anywhere] whitespace-normal">
                            {row.configured && (
                              <div className="@container min-w-0 rounded-md border bg-background p-4">
                                <ConnectorSchedulePane
                                  row={row}
                                  polling={polling}
                                  reconcileIntervalSecs={
                                    data.typical_read_interval_ms == null
                                      ? null
                                      : data.typical_read_interval_ms / 1000
                                  }
                                />
                              </div>
                            )}
                            <div className="min-w-0 rounded-md border bg-background p-4">
                              <ConnectorSyncHistory
                                instance={row}
                                asOf={data.as_of}
                              />
                            </div>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null,
                ];
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function InstanceCell({ instance }: { instance: ConnectorInstanceRef }) {
  const label = describeInstance(instance);

  return (
    <TableCell aria-label={label}>
      {label === UNMEASURED ? (
        UNMEASURED
      ) : (
        <>
          <span className="block">{instance.source_id || UNMEASURED}</span>
          <span
            className="block max-w-40 truncate text-xs text-muted-foreground"
            title={instance.tenant_id || UNMEASURED}
          >
            {instance.tenant_id || UNMEASURED}
          </span>
        </>
      )}
    </TableCell>
  );
}

function ScheduleCell({ row }: { row: ConnectorHealth }) {
  const request = row.schedule_request;
  const schedule =
    request?.last_observation?.status === "applied" && request.crons.length
      ? {
          crons: request.crons,
          timezone: "UTC",
          suspended: row.schedule?.suspended ?? false,
        }
      : row.schedule;
  const tooltipId = useId();
  const nextRun =
    schedule == null ? null : describeNextRun(schedule, new Date());

  return (
    <TableCell className="align-middle">
      <div
        data-slot="schedule-next"
        className="flex items-center gap-1.5 leading-5 whitespace-nowrap"
      >
        {schedule == null ? (
          UNMEASURED
        ) : (
          <Tooltip>
            <TooltipTrigger
              aria-describedby={tooltipId}
              render={
                <button type="button" className="cursor-help text-left" />
              }
            >
              {nextRun?.text}
            </TooltipTrigger>
            <TooltipContent id={tooltipId} role="tooltip">
              <div className="flex flex-col">
                {schedule.crons.map((cron, index) => (
                  <span key={index} className="block font-mono">
                    {cron}
                  </span>
                ))}
                <span className="block text-muted-foreground">
                  {describeSchedule(schedule)}
                </span>
                {nextRun?.detail != null && (
                  <span className="block">{nextRun.detail}</span>
                )}
              </div>
            </TooltipContent>
          </Tooltip>
        )}
        <ConnectorScheduleRequestChip row={row} />
      </div>
    </TableCell>
  );
}

function DurationCell({
  sync,
  asOf,
}: {
  sync: ConnectorHealth["last_sync"];
  asOf: string;
}) {
  const duration = describeDuration(sync, asOf);
  return (
    <TableCell
      className="text-right tabular-nums"
    >
      {duration.text}
    </TableCell>
  );
}
