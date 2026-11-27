import {
  Fragment,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
      className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-1.5 gap-y-0.5 rounded-md border px-1.5 py-0.5 text-xs sm:px-2 sm:py-1"
    >
      <ConnectorTimestamp
        value={stamp}
        className="col-span-2 row-start-2 text-xs text-muted-foreground tabular-nums"
      />
      <span className="col-start-1 row-start-1 flex justify-center self-start">
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
            current && "inset-ring-1 inset-ring-current/45"
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
      <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="whitespace-nowrap">{children}</span>
        <span className="ml-auto whitespace-nowrap text-muted-foreground tabular-nums">
          {formatDuration(duration)}
        </span>
      </div>
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
        <strong className="min-w-0 font-semibold whitespace-normal">
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
            <CardTitle render={<h5 />} className="text-sm">
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
      <h5 className="text-sm font-semibold">
        {t("connectors.history.load_utc", { step: stepLabel("bronze") })}
      </h5>
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

export function ConnectorRunHistory({ runs, syncs, limit, asOf }: Props) {
  const { t } = useTranslation();
  const heading = useId();
  const detailsId = `${heading}-detail`;
  const container = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<"narrow" | "stacked" | "wide">(
    "stacked"
  );
  const [selectedId, select] = useState<string | null>(null);
  const [stepsOpen, setStepsOpen] = useState(false);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    function updateLayout(width: number) {
      setLayout(width < 512 ? "narrow" : width >= 1040 ? "wide" : "stacked");
    }
    updateLayout(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) =>
      updateLayout(entry.contentRect.width)
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const history = recentHistory(runs, syncs, limit);
  const selected = history.find((item) => item.id === selectedId) ?? history[0];

  const [detailsRef, captureDetailsHeight] = useHeightTransition<HTMLElement>(
    selected?.id
  );
  const inlineDetails = layout === "narrow" && selectedId !== null;

  function openRun(id: string) {
    if (stepsOpen && id !== selected?.id) captureDetailsHeight();
    select(id);
    setStepsOpen(true);
    requestAnimationFrame(() => {
      const details = detailsRef.current;
      details?.focus({ preventScroll: true });
      details?.scrollIntoView?.({ block: "nearest" });
    });
  }

  const details = selected && (
    <section
      ref={detailsRef}
      id={detailsId}
      aria-labelledby={`${detailsId}-heading`}
      tabIndex={-1}
      className="min-w-0 scroll-mt-16 space-y-1.5 rounded-md border bg-muted/20 p-2 whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 @min-[1040px]:col-start-2 @min-[1040px]:row-start-1 @min-[1040px]:p-3"
    >
      <h4 id={`${detailsId}-heading`} className="text-xs font-semibold">
        {t("connectors.runs.selected")}
      </h4>
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
    </section>
  );

  return (
    <div
      ref={container}
      className="@container min-w-0 space-y-1.5 whitespace-normal sm:space-y-2"
    >
      <section aria-labelledby={heading} className="space-y-1.5 sm:space-y-2">
        <div className="flex items-center gap-3">
          <h3 id={heading} className="shrink-0 text-sm font-semibold">
            {t("connectors.history.heading")}
            {history.length > 0 && ` · ${history.length}`}
          </h3>
          {history.length > 0 && (
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
                  <Tooltip key={id}>
                    <TooltipTrigger
                      render={<li />}
                      role="listitem"
                      tabIndex={-1}
                      className="group relative h-7 min-w-0"
                      aria-label={label}
                      aria-current={id === selected?.id || undefined}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 border-background/50 group-not-last:border-r group-first:rounded-l-full group-last:rounded-r-full",
                          historySegmentStyle(record.status, state.tone)
                        )}
                      />
                      {id === selected?.id && (
                        <span
                          aria-hidden="true"
                          className="absolute inset-x-0 bottom-0.5 mx-auto h-0.5 max-w-6 rounded-full bg-foreground"
                        />
                      )}
                    </TooltipTrigger>
                    <TooltipContent role="tooltip">{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </ol>
          )}
        </div>
        {selected ? (
          <div className="grid min-w-0 gap-2 @min-[1040px]:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] @min-[1040px]:items-start @min-[1040px]:gap-4">
            {layout === "stacked" && details}
            <div className="min-w-0 @min-[1040px]:col-start-1 @min-[1040px]:row-start-1">
              <ConnectorSyncTable
                id={`${heading}-table`}
                selection={{
                  selectedId: selected.id,
                  detailsId,
                  inlineDetails: inlineDetails ? details : undefined,
                  onSelect: openRun,
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
            </div>
            {layout !== "stacked" && !inlineDetails && details}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("connectors.history.empty")}
          </p>
        )}
      </section>
    </div>
  );
}
