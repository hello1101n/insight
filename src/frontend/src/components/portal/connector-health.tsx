import { ChevronRight } from "lucide-react";
import { useId, useState, type MouseEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import type {
  ConnectorHealth,
  ConnectorInstanceRef,
} from "@/api/connector-health-client";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import {
  Badge,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
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
import {
  describeRun,
  isActiveRun,
  projectRun,
  runDuration,
} from "@/lib/portal/connector-runs";
import { ConnectorSyncHistory } from "./connector-sync-history";
import { ConnectorRunState, RunningSyncIndicator } from "./connector-run-state";
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
  panelIdFor,
} from "@/lib/portal/connector-health";
import { useConnectorHealth } from "@/queries/connector-health";
import {
  activatesRow,
  activatesRowByKey,
} from "@/lib/identities/row-activation";
import { cn } from "@/lib/utils";

const COLUMNS = 7;

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
      {data.history_read_error && (
        <p role="alert" className="text-sm text-warning">
          {data.history_read_error}
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
                const run = row.latest_run && projectRun(row.latest_run);
                const showRun =
                  run &&
                  (row.configured ||
                    isActiveRun(run) ||
                    data.checked_at == null ||
                    Date.parse(run.started_at) > Date.parse(data.checked_at));
                const state = showRun
                  ? describeRun(run.status)
                  : describeConnector(row);
                const latest = run ?? row.last_sync;
                const key = instanceKey(row);
                const open = expanded === key;
                const panelId = panelIdFor(row);
                const toggle = (
                  event:
                    | MouseEvent<HTMLTableRowElement>
                    | KeyboardEvent<HTMLTableRowElement>
                ) => {
                  setExpanded(open ? null : key);
                  const trigger = event.currentTarget.cells[0];
                  if (
                    !open &&
                    window.matchMedia?.(
                      "(max-width: 639px), (max-height: 839px)"
                    ).matches
                  )
                    requestAnimationFrame(() =>
                      trigger?.scrollIntoView?.({
                        block: "start",
                        inline: "nearest",
                      })
                    );
                };
                return [
                  <TableRow
                    key={key}
                    data-state-name={state.state}
                    data-state={open ? "selected" : undefined}
                    tabIndex={0}
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={(event) => {
                      if (activatesRow(event)) toggle(event);
                    }}
                    onKeyDown={(event) => {
                      if (!activatesRowByKey(event)) return;
                      event.preventDefault();
                      toggle(event);
                    }}
                    className="cursor-pointer select-text"
                  >
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <ChevronRight
                          aria-hidden="true"
                          className={cn(
                            "size-3.5 shrink-0 transition-transform duration-350 motion-reduce:transition-none",
                            open && "rotate-90"
                          )}
                        />
                        {row.connector}
                      </span>
                    </TableCell>
                    <InstanceCell instance={row} />
                    <ScheduleCell row={row} />
                    <TableCell>
                      {showRun ? (
                        <ConnectorRunState run={run} asOf={data.as_of} />
                      ) : (
                        <Badge
                          variant={TONE_BADGE[state.tone]}
                          data-tone={state.tone}
                        >
                          {state.state === "syncing" && (
                            <RunningSyncIndicator />
                          )}
                          {state.label}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatStarted(latest?.started_at ?? null)}
                    </TableCell>
                    {run ? (
                      <TableCell className="text-right tabular-nums">
                        {runDuration(run, data.as_of)}
                      </TableCell>
                    ) : (
                      <DurationCell sync={row.last_sync} asOf={data.as_of} />
                    )}
                    <TableCell className="text-right tabular-nums">
                      {formatRecords(latest?.records_reported ?? null)}
                    </TableCell>
                  </TableRow>,
                  <Collapsible
                    key={`syncs-${key}`}
                    open={open}
                    render={<TableRow aria-hidden={!open} />}
                    className="hidden has-[[data-slot=connector-details]:not([hidden])]:table-row"
                  >
                    <TableCell
                      colSpan={COLUMNS}
                      id={panelId}
                      className="h-auto! border-b-0! py-0! whitespace-normal"
                    >
                      <CollapsibleContent
                        data-slot="connector-details"
                        inert={!open}
                        className="min-w-0 overflow-clip! [contain:inline-size] motion-safe:transition-[height,opacity] motion-safe:duration-350 motion-safe:ease-out motion-safe:data-[ending-style]:opacity-0 motion-safe:data-[starting-style]:opacity-0"
                      >
                        <div className="sticky left-4 grid w-[calc(100cqw-2rem)] max-w-full min-w-0 grid-cols-1 gap-2 py-1 [overflow-wrap:anywhere] whitespace-normal sm:py-2">
                          {row.configured && (
                            <Card
                              size="sm"
                              className="@container min-w-0 px-3 py-1"
                            >
                              <ConnectorSchedulePane
                                row={row}
                                polling={polling}
                                collapseDetails
                                reconcileIntervalSecs={
                                  data.typical_read_interval_ms == null
                                    ? null
                                    : data.typical_read_interval_ms / 1000
                                }
                              />
                            </Card>
                          )}
                          <Card size="sm" className="min-w-0 p-2 sm:p-3">
                            <ConnectorSyncHistory
                              instance={row}
                              asOf={data.as_of}
                            />
                          </Card>
                        </div>
                      </CollapsibleContent>
                    </TableCell>
                  </Collapsible>,
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
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto cursor-help p-0 text-left font-normal"
                />
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
    <TableCell className="text-right tabular-nums">{duration.text}</TableCell>
  );
}
