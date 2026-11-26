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
import { useHeightTransition } from "@/hooks/use-height-transition";
import {
  historySegmentStyle,
  TONE_BADGE,
  TONE_STYLE,
} from "./connector-health-tone";
import { ConnectorRunBands } from "./connector-run-bands";
import {
  ConnectorRunState,
  RunningSyncIndicator,
  RunTooltip,
} from "./connector-run-state";
import { ConnectorSyncTable } from "./connector-sync-table";
import { ConnectorRunPeriod, ConnectorTimestamp } from "./connector-timestamp";

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
  const [detailsOpen, setDetailsOpen] = useState(false);
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
      data-metrics-expanded={detailsOpen ? "" : undefined}
      className="min-w-0 gap-1 px-2 py-1 sm:px-3 sm:py-1.5"
    >
      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <div className="mb-0.5 flex flex-wrap items-center gap-x-2">
          <CardTitle render={<h3 />} className="text-xs font-semibold">
            {metrics.length > 0 || run?.finished_at ? (
              <CollapsibleTrigger
                type="button"
                className="group inline-flex min-h-6 cursor-pointer items-center gap-1 rounded-sm text-start focus-visible:outline-2"
              >
                {title}
                <ChevronRight
                  aria-hidden="true"
                  className="size-3 shrink-0 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
                />
              </CollapsibleTrigger>
            ) : (
              title
            )}
          </CardTitle>
          {run &&
            run.status !== "succeeded" &&
            (!detailsOpen ||
              !metrics.some(({ label }) => label === state?.label)) && (
              <ConnectorRunState
                run={run}
                asOf={asOf}
                timing={timing ?? undefined}
                showRunning
              />
            )}
        </div>
        {run == null ? (
          <p className="text-xs text-muted-foreground">{empty}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground tabular-nums">
              <ConnectorRunPeriod
                startedAt={run.started_at}
                finishedAt={detailsOpen ? run.finished_at : null}
              />
            </p>
            <CollapsibleContent>
              {metrics.length > 0 && (
                <dl className="mt-1 grid w-full grid-cols-[repeat(auto-fit,minmax(min(5rem,100%),1fr))] gap-2 border-t pt-1">
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
                              <Badge
                                variant={TONE_BADGE[tone]}
                                data-tone={tone}
                              >
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
            </CollapsibleContent>
          </>
        )}
      </Collapsible>
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
  return (
    <li
      aria-current={current ? "step" : undefined}
      className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-0.5 rounded-md border px-1.5 py-0.5 text-xs sm:px-2 sm:py-1"
    >
      <ConnectorTimestamp
        value={stamp}
        className="col-span-3 row-start-2 text-xs text-muted-foreground tabular-nums"
      />
      <span className="col-start-1 row-start-1 flex justify-center">
        <span
          role="img"
          aria-label={pending ? undefined : stateLabel}
          aria-hidden={pending || undefined}
          title={pending ? undefined : stateLabel}
          className={cn(
            "grid size-4 place-items-center rounded-full",
            pending
              ? "border border-dashed border-muted-foreground/50 bg-card"
              : TONE_STYLE[tone],
            current && "ring-2 ring-current/45 ring-offset-2 ring-offset-card"
          )}
        >
          {!pending &&
            (kind === "running" && current ? (
              <RunningSyncIndicator />
            ) : (
              <Icon className="size-3" aria-hidden="true" strokeWidth={2.5} />
            ))}
        </span>
      </span>
      <div className="col-start-2 row-start-1 min-w-0">{children}</div>
      <span className="col-start-3 row-start-1 text-right text-xs text-muted-foreground tabular-nums">
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

function Timeline({
  run,
  asOf,
  stepsOpen,
  onStepsOpenChange,
}: {
  run: ConnectorRun;
  asOf: string;
  stepsOpen: boolean;
  onStepsOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const timing = summarizeRun(run, asOf);
  const heading = t("connectors.runs.timeline");
  return (
    <section className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs tabular-nums sm:text-sm">
        <strong className="font-semibold">
          <ConnectorRunPeriod
            startedAt={run.started_at}
            finishedAt={run.finished_at}
          />
        </strong>
        <div className="flex min-w-0 items-start gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">{runDuration(run, asOf)}</span>
          <ConnectorRunState
            run={run}
            asOf={asOf}
            timing={timing}
            inlineReason
          />
        </div>
      </div>
      <ConnectorRunBands timing={timing} />
      {timing.steps.length > 0 || timing.trailingQueue ? (
        <Card size="sm" className="min-w-0 px-2 py-1.5">
          <Collapsible open={stepsOpen} onOpenChange={onStepsOpenChange}>
            <CardTitle render={<h4 />} className="text-sm">
              <CollapsibleTrigger
                type="button"
                className="group flex w-full cursor-pointer items-center justify-between gap-2 rounded-sm text-start focus-visible:outline-2"
              >
                {heading}
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform duration-350 group-aria-expanded:rotate-90 motion-reduce:transition-none"
                />
              </CollapsibleTrigger>
            </CardTitle>
            <CollapsibleContent className="motion-safe:transition-[height,opacity] motion-safe:duration-350 motion-safe:ease-out motion-safe:data-[ending-style]:opacity-0 motion-safe:data-[starting-style]:opacity-0">
              <ol
                aria-label={heading}
                className="grid grid-cols-2 gap-1.5 pt-1.5 @lg:grid-cols-4"
              >
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
        <ConnectorTimestamp value={sync.started_at} />
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
  const detailsId = `${heading}-detail`;
  const [selectedId, select] = useState<string | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);

  function openRun(id: string, scrollToDetails = false) {
    if (stepsOpen && id !== selected?.id) captureDetailsHeight();
    select(id);
    setStepsOpen(true);
    if (scrollToDetails)
      requestAnimationFrame(() => {
        const details = detailsRef.current;
        details?.focus({ preventScroll: true });
        details?.scrollIntoView?.({ block: "nearest" });
      });
  }
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

  const [detailsRef, captureDetailsHeight] = useHeightTransition(selected?.id);

  return (
    <div className="@container min-w-0 space-y-1.5 whitespace-normal sm:space-y-2">
      <div className="grid min-w-0 grid-cols-2 items-start gap-1.5 has-[>section[data-metrics-expanded]+section[data-metrics-expanded]]:items-stretch">
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
      <section aria-labelledby={heading} className="space-y-1.5 sm:space-y-2">
        <div className="flex items-center gap-3">
          <h3 id={heading} className="shrink-0 text-sm font-semibold">
            {t("connectors.history.heading")}
            {history.length > 0 && ` · ${history.length}`}
          </h3>
          <ol
            aria-label={t("connectors.history.statuses_label")}
            className="grid max-w-xs min-w-0 flex-1"
            style={{
              gridTemplateColumns: `repeat(${Math.max(history.length, 1)}, minmax(0, 1fr))`,
            }}
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
                      render={
                        <Button type="button" size="sm" variant="ghost" />
                      }
                      className="relative block h-7 w-full min-w-0 rounded-none border-0 bg-transparent p-0 hover:bg-transparent focus-visible:z-10 aria-pressed:after:absolute aria-pressed:after:inset-x-0 aria-pressed:after:bottom-0.5 aria-pressed:after:mx-auto aria-pressed:after:h-0.5 aria-pressed:after:w-full aria-pressed:after:max-w-6 aria-pressed:after:rounded-full aria-pressed:after:bg-foreground"
                      aria-label={label}
                      aria-controls={detailsId}
                      aria-pressed={id === selected?.id}
                      onClick={() => openRun(id)}
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
        </div>
        {selected && (
          <div
            ref={detailsRef}
            id={detailsId}
            tabIndex={-1}
            className="scroll-mt-16 focus:outline-none"
          >
            {"sync_id" in selected.record ? (
              <Timeline
                run={selected.record}
                asOf={asOf}
                stepsOpen={stepsOpen}
                onStepsOpenChange={setStepsOpen}
              />
            ) : (
              <HistoricalLoad sync={selected.record} asOf={asOf} />
            )}
          </div>
        )}
        {selected && (
          <ConnectorSyncTable
            id={`${heading}-table`}
            selection={{
              selectedId: selected.id,
              detailsId,
              onSelect: (id) => openRun(id, true),
            }}
            rows={history.map(({ id, record }) => {
              if ("sync_id" in record)
                return {
                  id,
                  status: describeRunState(record, asOf),
                  started: record.started_at,
                  duration: runDuration(record, asOf),
                  inFlight: isActiveRun(record),
                  records: record.records_reported,
                };

              const state = describeSync(record);
              const duration = describeDuration(record, asOf);
              return {
                id,
                status: state,
                started: record.started_at,
                duration: duration.text,
                inFlight: duration.inFlight,
                records: record.records_reported,
              };
            })}
          />
        )}
      </section>
    </div>
  );
}
