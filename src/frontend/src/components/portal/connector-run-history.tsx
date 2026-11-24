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

import type { ConnectorRun, SyncFact } from "@/api/connector-health-client";
import {
  describeDuration,
  describeSync,
  formatDuration,
  formatRecords,
  formatStarted,
  type ConnectorTone,
} from "@/lib/portal/connector-health";
import { summarizeRun } from "@/lib/portal/connector-run-timing";
import { describeRunState } from "@/lib/portal/connector-run-view";
import {
  describeRun,
  isActiveRun,
  projectRun,
  queueDetails,
  queueSeverity,
  runDuration,
  stageFailureDetails,
  stepDetail,
  stepLabel,
} from "@/lib/portal/connector-runs";
import { cn } from "@/lib/utils";
import {
  historySegmentStyle,
  TONE_BADGE,
  TONE_STYLE,
} from "./connector-health-tone";
import { ConnectorRunBands } from "./connector-run-bands";
import { ConnectorRunState, RunTooltip } from "./connector-run-state";

function RunMetrics({
  run,
  title,
  empty,
  asOf,
}: {
  run?: ConnectorRun | null;
  title: string;
  empty: string;
  asOf: string;
}) {
  const { t } = useTranslation();
  const timing = run && summarizeRun(run, asOf);
  const state = run && describeRunState(run, asOf, timing ?? undefined);
  const queuedLabel = t("connectors.runs.queued");
  const metrics = timing
    ? timing.steps.map((step) => ({
        label: stepLabel(step.step),
        details: [stepDetail(step.step)],
        duration: step.duration,
        tone: null as ConnectorTone | null,
      }))
    : [];
  if (timing?.queued)
    metrics.unshift({
      label: queuedLabel,
      details: queueDetails(timing.queued.reasons, timing.queued.tone),
      duration: timing.queued.duration,
      tone: timing.queued.tone === "idle" ? null : timing.queued.tone,
    });

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
          {!metrics.some(({ label }) => label === state?.label) && (
            <ConnectorRunState
              run={run}
              asOf={asOf}
              timing={timing ?? undefined}
              showRunning
            />
          )}
          {metrics.length > 0 && (
            <dl className="grid w-full grid-cols-[repeat(auto-fit,minmax(min(5rem,100%),1fr))] gap-2 border-t pt-2">
              {metrics.map(({ label, details, duration, tone }) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">
                    {label === state?.label ? (
                      <ConnectorRunState
                        run={run}
                        asOf={asOf}
                        timing={timing ?? undefined}
                        showRunning
                      />
                    ) : (
                      <RunTooltip lines={details}>
                        {tone ? (
                          <Badge variant={TONE_BADGE[tone]} data-tone={tone}>
                            {label}
                          </Badge>
                        ) : (
                          label
                        )}
                      </RunTooltip>
                    )}
                  </dt>
                  <dd className="text-sm font-medium tabular-nums">
                    {formatDuration(duration)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </Card>
  );
}

function StepEvent({
  at,
  status,
  tone,
  duration,
  current,
  pending = false,
  children,
}: {
  at: number | null;
  status: string;
  tone: ConnectorTone;
  duration: number | null;
  current: boolean;
  pending?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const kind = describeRun(status).kind;
  const stateLabel = t(
    kind === "succeeded"
      ? "connectors.runs.step_complete"
      : `connectors.runs.${kind}`
  );
  const Icon =
    status === "succeeded"
      ? Check
      : status === "cancelled"
        ? Ban
        : tone === "failing"
          ? X
          : status === "queued"
            ? Clock3
            : tone === "active"
              ? Activity
              : Circle;
  const stamp = at == null ? undefined : new Date(at).toISOString();
  const label = formatStarted(stamp);
  return (
    <li
      aria-current={current ? "step" : undefined}
      className="group grid grid-cols-[8ch_1.25rem_minmax(0,1fr)_auto] items-start gap-x-2 py-2 text-sm sm:gap-x-3"
    >
      <time
        dateTime={stamp}
        title={label}
        aria-label={label}
        className="pt-0.5 text-xs text-muted-foreground tabular-nums"
      >
        {stamp ? label.slice(11, 19) : label}
      </time>
      <span className="relative flex h-full min-h-5 justify-center after:absolute after:top-4 after:bottom-[-1.125rem] after:left-1/2 after:w-px after:bg-border group-last:after:hidden">
        <span
          role="img"
          aria-label={pending ? undefined : stateLabel}
          aria-hidden={pending || undefined}
          title={pending ? undefined : stateLabel}
          className={cn(
            "relative z-1 grid size-5 place-items-center rounded-full",
            pending
              ? "border border-dashed border-muted-foreground/50 bg-card"
              : TONE_STYLE[tone],
            current && "ring-2 ring-current/45 ring-offset-2 ring-offset-card"
          )}
        >
          {!pending && (
            <Icon className="size-3" aria-hidden="true" strokeWidth={2.5} />
          )}
        </span>
      </span>
      <div className="min-w-0">{children}</div>
      <span className="pt-0.5 text-right text-xs text-muted-foreground tabular-nums">
        {formatDuration(duration)}
      </span>
    </li>
  );
}

type QueueTiming = NonNullable<ReturnType<typeof summarizeRun>["queued"]>;

function QueuedEvent({
  queue,
  timedOut = false,
}: {
  queue: QueueTiming;
  timedOut?: boolean;
}) {
  const { t } = useTranslation();
  const tone = timedOut ? "idle" : queue.tone;
  return (
    <StepEvent {...queue} status="queued" tone={tone}>
      <RunTooltip lines={queueDetails(queue.reasons, tone)}>
        {t("connectors.runs.queued")}
      </RunTooltip>
    </StepEvent>
  );
}

function Timeline({ run, asOf }: { run: ConnectorRun; asOf: string }) {
  const { t } = useTranslation();
  const startStamp = formatStarted(run.started_at).replace(/Z$/, "");
  const endStamp = formatStarted(run.finished_at).replace(/Z$/, "");
  const sameDay = startStamp.slice(0, 10) === endStamp.slice(0, 10);
  const timing = summarizeRun(run, asOf);
  const heading = t("connectors.runs.timeline");
  return (
    <section className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2 text-sm tabular-nums">
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
        <div className="flex flex-wrap items-start gap-2 text-xs text-muted-foreground">
          {runDuration(run, asOf)}
          <ConnectorRunState run={run} asOf={asOf} timing={timing} />
        </div>
      </div>
      <ConnectorRunBands timing={timing} />
      {timing.steps.length > 0 || timing.trailingQueue ? (
        <Card size="sm" className="min-w-0 p-3 sm:p-4">
          <Collapsible defaultOpen>
            <CardTitle render={<h4 />} className="text-sm">
              <CollapsibleTrigger
                type="button"
                className="group flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm text-start focus-visible:outline-2"
              >
                {heading}
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground group-aria-expanded:rotate-90"
                />
              </CollapsibleTrigger>
            </CardTitle>
            <CollapsibleContent>
              <ol aria-label={heading} className="pt-2">
                {timing.steps.map(({ step, queued, failure, ...event }) => {
                  const state = describeRun(event.status);
                  return (
                    <Fragment key={step}>
                      {queued && (
                        <QueuedEvent
                          queue={queued}
                          timedOut={failure?.status === "wait_timeout"}
                        />
                      )}
                      <StepEvent
                        {...event}
                        tone={state.tone}
                        pending={state.kind === "queued"}
                      >
                        <RunTooltip
                          lines={[
                            stepDetail(step),
                            ...(failure ? stageFailureDetails(failure) : []),
                          ]}
                        >
                          <strong className="font-medium">
                            {stepLabel(step)}
                          </strong>
                        </RunTooltip>
                      </StepEvent>
                    </Fragment>
                  );
                })}
                {timing.trailingQueue && (
                  <QueuedEvent queue={timing.trailingQueue} />
                )}
              </ol>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("connectors.runs.no_steps")}
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
        {t("connectors.history.load_utc", { step: stepLabel("bronze") })}
      </h4>
      <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
        <time>{formatStarted(sync.started_at)}</time>
        <Badge variant={TONE_BADGE[status.tone]} data-tone={status.tone}>
          {status.label}
        </Badge>
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
  const recent = latest ? projectRun(latest) : undefined;
  const managed = runs.map(projectRun);
  if (recent && !managed.some((run) => run.sync_id === recent.sync_id))
    managed.unshift(recent);

  const current = recent ?? managed[0];
  const recordedSuccess = lastSuccess && projectRun(lastSuccess);
  const newestSuccess = managed.find((run) => run.status === "succeeded");
  const successful =
    newestSuccess &&
    (!recordedSuccess ||
      Date.parse(newestSuccess.started_at) >
        Date.parse(recordedSuccess.started_at))
      ? newestSuccess
      : recordedSuccess;
  const history = recentHistory(managed, syncs, limit);
  const selected = history.find((item) => item.id === selectedId) ?? history[0];
  return (
    <div className="@container min-w-0 space-y-4 whitespace-normal">
      <div className="grid min-w-0 gap-2 @lg:grid-cols-2">
        <RunMetrics
          title={t("connectors.runs.latest_success")}
          empty={t("connectors.runs.no_success")}
          run={successful}
          asOf={asOf}
        />
        <RunMetrics
          title={t("connectors.runs.current")}
          empty={t("connectors.runs.no_current")}
          run={current && isActiveRun(current) ? current : null}
          asOf={asOf}
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
                ? describeRunState(record, asOf)
                : describeSync(record);
            const severity =
              "kind" in state && state.kind === "queued"
                ? queueSeverity(state.tone)
                : null;
            const label = [
              formatStarted(record.started_at),
              state.label,
              severity,
            ]
              .filter(Boolean)
              .join(" · ");
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
