import { Fragment, useId, useState, type ReactNode } from "react";
import {
  Activity,
  Ban,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@gears-frontx/ui-kit";
import { ConnectorRunBands } from "./connector-run-bands";

import type { ConnectorRun, SyncFact } from "@/api/connector-health-client";
import {
  describeDuration,
  describeSync,
  elapsedMs,
  formatDuration,
  formatRecords,
  formatStarted,
} from "@/lib/portal/connector-health";
import {
  describeRun,
  isActiveRun,
  stageFailureReason,
  runDuration,
} from "@/lib/portal/connector-runs";
import { cn } from "@/lib/utils";
import { historySegmentStyle, TONE_BADGE } from "./connector-health-tone";

function RunBadge({ status }: { status: string }) {
  const view = describeRun(status);
  return (
    <Badge
      variant={TONE_BADGE[view.tone]}
      className="whitespace-normal"
    >
      {view.label}
    </Badge>
  );
}

function RunMetrics({
  run,
  title,
  empty,
}: {
  run?: ConnectorRun | null;
  title: string;
  empty: string;
}) {
  const { t } = useTranslation();
  return (
    <Card
      size="sm"
      render={<section />}
      className="min-w-0 items-start gap-2 p-3"
    >
      <CardTitle render={<h3 />} className="text-sm">
        {title}
      </CardTitle>
      {run == null ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <>
          <p className="text-xs tabular-nums">
            {formatStarted(run.started_at)}
            {run.finished_at && <> – {formatStarted(run.finished_at)}</>}
          </p>
          <RunBadge status={run.status} />
          <dl className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(6rem,100%),1fr))] gap-2 border-t pt-2">
            {(
              [
                ["wait", run.wait_ms],
                ["load", run.load_ms],
                ["transform", run.transform_ms],
              ] as const
            )
              .filter(
                ([key, value]) => key !== "wait" || (value != null && value > 0)
              )
              .map(([key, value]) => (
                <div key={key}>
                  <dt className="text-xs text-muted-foreground">
                    {t(`connectors.runs.${key}`)}
                  </dt>
                  <dd className="text-sm font-medium tabular-nums">
                    {formatDuration(value)}
                  </dd>
                </div>
              ))}
          </dl>
        </>
      )}
    </Card>
  );
}

function StageEvent({
  at,
  status,
  duration,
  current = false,
  upcoming = false,
  children,
}: {
  at?: string | null;
  status: string;
  duration?: string;
  current?: boolean;
  upcoming?: boolean;
  children: ReactNode;
}) {
  const state = describeRun(status);
  const complete = status === "succeeded";
  const waiting =
    status.startsWith("waiting") ||
    status === "wait_warning" ||
    status === "queued";
  const Icon = complete
    ? Check
    : status === "cancelled"
      ? Ban
      : state.tone === "failing"
        ? X
        : waiting
          ? Clock3
          : state.tone === "active"
            ? Activity
            : Circle;
  const stamp = formatStarted(at);
  return (
    <li
      aria-current={current ? "step" : undefined}
      className="group grid grid-cols-[8ch_1.25rem_minmax(0,1fr)_auto] items-start gap-x-2 py-2 text-sm sm:gap-x-3"
    >
      <time
        dateTime={at ?? undefined}
        title={stamp}
        aria-label={stamp}
        className="pt-0.5 text-xs text-muted-foreground tabular-nums"
      >
        {stamp.includes(" ") ? stamp.slice(11, 19) : stamp}
      </time>
      <span className="relative flex h-full min-h-5 justify-center after:absolute after:top-4 after:bottom-[-1.125rem] after:left-1/2 after:w-px after:bg-border group-last:after:hidden">
        <span
          role="img"
          aria-label={upcoming ? undefined : state.label}
          aria-hidden={upcoming || undefined}
          title={upcoming ? undefined : state.label}
          className={cn(
            "relative z-1 grid size-5 place-items-center rounded-full",
            upcoming
              ? "border border-dashed border-muted-foreground/50 bg-card"
              : TONE_BADGE[state.tone],
            current && "ring-2 ring-current/45 ring-offset-2 ring-offset-card"
          )}
        >
          {!upcoming && (
            <Icon className="size-3" aria-hidden="true" strokeWidth={2.5} />
          )}
        </span>
      </span>
      <div className="min-w-0">{children}</div>
      <span className="pt-0.5 text-right text-xs text-muted-foreground tabular-nums">
        {duration}
      </span>
    </li>
  );
}

function Timeline({ run, asOf }: { run: ConnectorRun; asOf: string }) {
  const { t } = useTranslation();
  const startStamp = formatStarted(run.started_at).replace(/Z$/, "");
  const endStamp = formatStarted(run.finished_at).replace(/Z$/, "");
  const sameDay = startStamp.slice(0, 10) === endStamp.slice(0, 10);
  const readyBeforeChecks =
    run.status === "succeeded"
      ? run.stages.findIndex((stage) => stage.stage === "connector-checks")
      : -1;
  const finished = run.finished_at && (
    <StageEvent at={run.finished_at} status={run.status}>
      <strong className="font-medium">
        {run.status === "succeeded"
          ? t("connectors.runs.updated")
          : run.status === "cancelled"
            ? t("connectors.runs.sync_cancelled")
            : t("connectors.runs.completed")}
      </strong>
    </StageEvent>
  );
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm tabular-nums">
        <strong className="font-semibold">
          <time dateTime={run.started_at}>{startStamp}</time>
          {run.finished_at && (
            <>
              {" "}
              –{" "}
              <time dateTime={run.finished_at}>
                {sameDay ? endStamp.slice(11) : endStamp}
              </time>
            </>
          )}{" "}
          UTC
        </strong>
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          {runDuration(run, asOf)}
          <RunBadge status={run.status} />
        </span>
      </div>
      <ConnectorRunBands run={run} asOf={asOf} />
      {run.stages.length ? (
        <Card size="sm" className="min-w-0 p-3 sm:p-4">
          <Collapsible defaultOpen>
            <CardTitle render={<h4 />} className="text-sm">
              <CollapsibleTrigger
                type="button"
                className="group flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm text-start focus-visible:outline-2"
              >
                {t("connectors.runs.timeline")}
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground group-aria-expanded:rotate-90"
                />
              </CollapsibleTrigger>
            </CardTitle>
            <CollapsibleContent>
              <ol className="pt-2">
                {run.stages.map((stage, index) => {
                  const activeWait = stage.waits?.find(
                    (wait) => !wait.ended_at
                  );
                  const duration =
                    stage.duration_ms ??
                    (activeWait
                      ? elapsedMs(
                          run.finished_at ?? asOf,
                          activeWait.started_at
                        )
                      : isActiveRun(run) && !stage.finished_at
                        ? elapsedMs(asOf, stage.started_at)
                        : null);
                  return (
                    <Fragment
                      key={JSON.stringify([stage.stage, stage.attempt])}
                    >
                      {index === readyBeforeChecks && finished}
                      {stage.waits?.map(
                        (wait) =>
                          wait.ended_at && (
                            <StageEvent
                              key={wait.kind + wait.started_at}
                              at={wait.started_at}
                              status={
                                wait.kind === "admission"
                                  ? "waiting_admission"
                                  : "waiting_pod"
                              }
                              duration={formatDuration(
                                elapsedMs(wait.ended_at, wait.started_at)
                              )}
                            >
                              <span>
                                {t(
                                  wait.kind === "admission"
                                    ? "connectors.runs.waiting_admission"
                                    : "connectors.runs.waiting_pod"
                                )}
                              </span>
                            </StageEvent>
                          )
                      )}

                      <StageEvent
                        at={
                          activeWait?.started_at ??
                          stage.started_at ??
                          (stage.status === "cancelled"
                            ? stage.finished_at
                            : null) ??
                          stage.granted_at ??
                          stage.queued_at
                        }
                        status={stage.status}
                        current={
                          isActiveRun(run) &&
                          !stage.finished_at &&
                          stage.status !== "queued" &&
                          (describeRun(stage.status).tone === "active" ||
                            stage.status.startsWith("waiting_") ||
                            stage.status === "wait_warning" ||
                            !!activeWait)
                        }
                        duration={formatDuration(duration)}
                      >
                        <strong className="font-medium">
                          {t(`connectors.runs.stage.${stage.stage}`, {
                            defaultValue: stage.stage,
                          })}
                        </strong>
                        {stage.attempt > 1 && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            {t("connectors.runs.attempt", {
                              number: stage.attempt,
                            })}
                          </span>
                        )}
                        {stage.status !== "succeeded" && (
                          <span className="block text-xs text-muted-foreground">
                            {describeRun(stage.status).label}
                          </span>
                        )}
                        {stage.reason &&
                          stage.reason !== "stage_failed" &&
                          stage.reason !== stage.status && (
                            <span className="block text-xs text-muted-foreground">
                              {stage.status === "failed"
                                ? stageFailureReason(stage)
                                : t(`connectors.runs.reason.${stage.reason}`, {
                                    defaultValue: stage.reason,
                                  })}
                            </span>
                          )}
                      </StageEvent>
                    </Fragment>
                  );
                })}
                {readyBeforeChecks < 0 && finished}
                {isActiveRun(run) && (
                  <StageEvent status="queued" upcoming>
                    <span className="text-muted-foreground">
                      {t("connectors.runs.updated")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("connectors.runs.upcoming")}
                    </span>
                  </StageEvent>
                )}
              </ol>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("connectors.runs.no_stages")}
        </p>
      )}
    </section>
  );
}

interface Props {
  runs: ConnectorRun[];
  syncs: SyncFact[];
  limit: number;
  latest?: ConnectorRun | null;
  lastSuccess?: ConnectorRun | null;
  asOf: string;
}

function recentHistory(runs: ConnectorRun[], syncs: SyncFact[], limit: number) {
  const representedJobs = new Set(
    runs.flatMap((run) => run.stages.map((stage) => stage.airbyte_job_id))
  );
  const history: (ConnectorRun | SyncFact)[] = [
    ...runs,
    ...syncs.filter((sync) => !representedJobs.has(sync.job_id)),
  ];
  const start = (record: ConnectorRun | SyncFact) =>
    Date.parse(record.started_at ?? "") || 0;
  return history
    .sort((a, b) => start(b) - start(a))
    .slice(0, limit)
    .map((record) => ({
      id:
        "sync_id" in record ? `run:${record.sync_id}` : `job:${record.job_id}`,
      record,
    }));
}

function HistoricalLoad({ sync, asOf }: { sync: SyncFact; asOf: string }) {
  const { t } = useTranslation();
  const status = describeSync(sync);
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold">
        {t("connectors.history.load_utc")}
      </h4>
      <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
        <time>{formatStarted(sync.started_at)}</time>
        <Badge variant={TONE_BADGE[status.tone]}>{status.label}</Badge>
      </div>
      <dl className="flex flex-wrap gap-4 text-xs">
        <div>
          <dt className="text-muted-foreground">{t("connectors.duration")}</dt>
          <dd>{describeDuration(sync, asOf).text}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("connectors.history.records")}
          </dt>
          <dd>{formatRecords(sync.records_reported)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function ConnectorRunHistory({
  runs,
  syncs,
  limit,
  latest,
  lastSuccess,
  asOf,
}: Props) {
  const { t } = useTranslation();
  const heading = useId();
  const [selectedId, select] = useState<string | null>(null);
  const managed =
    latest && !runs.some((run) => run.sync_id === latest.sync_id)
      ? [latest, ...runs]
      : runs;
  const history = recentHistory(managed, syncs, limit);
  const selected = history.find((item) => item.id === selectedId) ?? history[0];
  const recent = latest ?? runs[0];
  return (
    <div className="@container min-w-0 space-y-4 whitespace-normal">
      <div className="grid min-w-0 gap-2 @lg:grid-cols-2">
        <RunMetrics
          title={t("connectors.runs.latest_success")}
          empty={t("connectors.runs.no_success")}
          run={lastSuccess ?? runs.find((run) => run.status === "succeeded")}
        />
        <RunMetrics
          title={t("connectors.runs.current")}
          empty={t("connectors.runs.no_current")}
          run={recent && isActiveRun(recent) ? recent : null}
        />
      </div>
      <section aria-labelledby={heading} className="space-y-2">
        <h3 id={heading} className="text-sm font-semibold">
          {t("connectors.history.heading")}
          {history.length > 0 && ` · ${history.length}`}
        </h3>
        <ol
          aria-label={t("connectors.history.statuses_label")}
          className="grid w-full min-w-0"
          style={{ gridTemplateColumns: `repeat(${limit}, minmax(0, 1fr))` }}
        >
          {history.toReversed().map(({ id, record }) => {
            const state =
              "sync_id" in record
                ? describeRun(record.status)
                : describeSync(record);
            const label = `${formatStarted(record.started_at)} · ${state.label}`;
            return (
              <li key={id} className="group min-w-0">
                <Tooltip>
                  <TooltipTrigger
                    render={<Button type="button" size="sm" variant="ghost" />}
                    className="relative block h-7 w-full min-w-0 rounded-none border-0 bg-transparent p-0 hover:bg-transparent focus-visible:z-10 aria-pressed:after:absolute aria-pressed:after:inset-x-0 aria-pressed:after:bottom-0.5 aria-pressed:after:mx-auto aria-pressed:after:h-0.5 aria-pressed:after:w-full aria-pressed:after:max-w-6 aria-pressed:after:rounded-full aria-pressed:after:bg-foreground"
                    aria-label={label}
                    aria-pressed={id === selected?.id}
                    onClick={() => select(id)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 border-background/50 group-not-last:border-r group-first:rounded-l-full group-last:rounded-r-full",
                        historySegmentStyle(record.status, state.tone)
                      )}
                    />
                  </TooltipTrigger>
                  <TooltipContent role="tooltip">{label}</TooltipContent>
                </Tooltip>
              </li>
            );
          })}
        </ol>
        {selected &&
          ("sync_id" in selected.record ? (
            <Timeline run={selected.record} asOf={asOf} />
          ) : (
            <HistoricalLoad sync={selected.record} asOf={asOf} />
          ))}
      </section>
    </div>
  );
}
