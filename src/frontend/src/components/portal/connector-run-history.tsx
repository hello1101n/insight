import { Fragment, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@gears-frontx/ui-kit";

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
  runDuration,
} from "@/lib/portal/connector-runs";
import { cn } from "@/lib/utils";
import { TONE_BAR_STYLE, TONE_BADGE } from "./connector-health-tone";

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
    <section className="min-w-0 space-y-2 rounded-md border p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {run == null ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <>
          <p className="text-xs tabular-nums">
            {formatStarted(run.started_at)}
            {run.finished_at && <> – {formatStarted(run.finished_at)}</>}
          </p>
          <RunBadge status={run.status} />
          <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(6rem,100%),1fr))] gap-2 border-t pt-2">
            {(
              [
                ["wait", run.wait_ms],
                ["load", run.load_ms],
                ["transform", run.transform_ms],
              ] as const
            ).map(([key, value]) => (
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
    </section>
  );
}

function Timeline({ run, asOf }: { run: ConnectorRun; asOf: string }) {
  const { t } = useTranslation();
  const readyBeforeChecks =
    run.status === "succeeded"
      ? run.stages.findIndex((stage) => stage.stage === "connector-checks")
      : -1;
  const finished = run.finished_at && (
    <li className="flex flex-wrap gap-3 py-2 text-xs">
      <time className="text-muted-foreground tabular-nums">
        {formatStarted(run.finished_at)}
      </time>
      <strong className="font-medium">
        {run.status === "succeeded"
          ? t("connectors.runs.updated")
          : t("connectors.runs.completed")}
      </strong>
      <RunBadge status={run.status} />
    </li>
  );
  return (
    <section className="min-w-0 space-y-2">
      <h4 className="text-sm font-semibold">{t("connectors.runs.timeline")}</h4>
      <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
        <time dateTime={run.started_at}>{formatStarted(run.started_at)}</time>
        <RunBadge status={run.status} />
        <span>{runDuration(run, asOf)}</span>
      </div>
      {run.stages.length ? (
        <ol className="divide-y border-l pl-3">
          {run.stages.map((stage, index) => {
            const queueEnd =
              stage.started_at ??
              (["unknown", "checking_start"].includes(stage.status)
                ? stage.granted_at
                : null);
            const waited = queueEnd
              ? elapsedMs(queueEnd, stage.queued_at)
              : null;
            const waiting =
              stage.started_at == null &&
              [
                "queued",
                "waiting_pod",
                "stopping_pod_wait",
                "waiting_clickhouse",
                "wait_warning",
                "wait_timeout",
              ].includes(stage.status);
            const duration =
              stage.duration_ms ??
              (waiting
                ? elapsedMs(
                    stage.finished_at ??
                      (stage.stage === "connector-checks"
                        ? asOf
                        : (run.finished_at ?? asOf)),
                    stage.queued_at
                  )
                : null);
            return (
              <Fragment key={JSON.stringify([stage.stage, stage.attempt])}>
                {index === readyBeforeChecks && finished}
                {waited != null && waited > 0 && (
                  <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-xs">
                    <time className="text-muted-foreground tabular-nums">
                      {formatStarted(stage.queued_at)}
                    </time>
                    <span>{t("connectors.runs.wait")}</span>
                    <span className="ml-auto tabular-nums">
                      {formatDuration(waited)}
                    </span>
                  </li>
                )}
                <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-xs">
                  <time className="text-muted-foreground tabular-nums">
                    {formatStarted(
                      stage.started_at ?? stage.granted_at ?? stage.queued_at
                    )}
                  </time>
                  <strong className="font-medium">
                    {t(`connectors.runs.stage.${stage.stage}`, {
                      defaultValue: stage.stage,
                    })}
                  </strong>
                  {stage.attempt > 1 && (
                    <span>
                      {t("connectors.runs.attempt", { number: stage.attempt })}
                    </span>
                  )}
                  <RunBadge status={stage.status} />
                  {stage.reason &&
                    stage.reason !== "stage_failed" &&
                    stage.reason !== stage.status && (
                      <span>
                        {t(`connectors.runs.reason.${stage.reason}`, {
                          defaultValue: stage.reason,
                        })}
                      </span>
                    )}
                  <span className="ml-auto tabular-nums">
                    {formatDuration(duration)}
                  </span>
                </li>
              </Fragment>
            );
          })}
          {readyBeforeChecks < 0 && finished}
        </ol>
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
        <Badge className={TONE_STYLE[status.tone]}>{status.label}</Badge>
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
          className="flex flex-wrap gap-0.5"
        >
          {history.toReversed().map(({ id, record }) => {
            const state =
              "sync_id" in record
                ? describeRun(record.status)
                : describeSync(record);
            const label = `${formatStarted(record.started_at)} · ${state.label}`;
            return (
              <li key={id}>
                <button
                  type="button"
                  className={cn(
                    "block h-5 w-3 rounded-sm focus-visible:outline-2 aria-pressed:ring-2 aria-pressed:ring-foreground",
                    TONE_BAR_STYLE[state.tone]
                  )}
                  aria-label={label}
                  title={label}
                  aria-pressed={id === selected?.id}
                  onClick={() => select(id)}
                />
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
