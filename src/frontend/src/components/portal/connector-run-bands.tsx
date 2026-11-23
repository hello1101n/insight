import { Tooltip, TooltipContent, TooltipTrigger } from "@gears-frontx/ui-kit";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ConnectorRun } from "@/api/connector-health-client";
import {
  elapsedMs,
  formatDuration,
  formatStarted,
} from "@/lib/portal/connector-health";
import { cn } from "@/lib/utils";
import { stageFailureReason } from "@/lib/portal/connector-runs";

const colors = {
  wait: "bg-muted-foreground",
  load: "bg-primary",
  transform: "bg-[light-dark(#7865b8,#b49af1)]",
  startup: "bg-[light-dark(#b4c7d8,#73869d)]",
  gap: "bg-[light-dark(#e2e6eb,#404b5c)]",
  unknown: "bg-muted-foreground/30",
};

export function ConnectorRunBands({
  run,
  asOf,
}: {
  run: ConnectorRun;
  asOf: string;
}) {
  const { t } = useTranslation();
  const end = run.finished_at ?? asOf;
  const span = elapsedMs(end, run.started_at) ?? 0;
  const bands: {
    start: number;
    end: number;
    kind: keyof typeof colors;
    label: string;
    stageKey?: string;
  }[] = [];
  function add(
    started: string,
    ended: string,
    kind: keyof typeof colors,
    label: string,
    stageKey?: string
  ) {
    const start = elapsedMs(started, run.started_at);
    const stop = elapsedMs(ended, run.started_at);
    if (start == null || stop == null || start >= span || stop <= start) return;
    const end = Math.min(stop, span);
    bands.push({
      start,
      end,
      kind,
      stageKey,
      label: [formatStarted(started), label, formatDuration(end - start)].join(
        " · "
      ),
    });
  }
  for (const stage of run.stages) {
    if (stage.stage === "connector-checks") continue;
    const label = t(`connectors.runs.stage.${stage.stage}`, {
      defaultValue: stage.stage,
    });
    for (const wait of stage.waits ?? []) {
      const reason = t(
        wait.kind === "placement"
          ? "connectors.runs.waiting_pod"
          : "connectors.runs.waiting_admission"
      );
      add(
        wait.started_at,
        wait.ended_at ?? stage.started_at ?? stage.finished_at ?? end,
        "wait",
        `${label} · ${reason}`
      );
    }
    if (stage.started_at) {
      add(
        stage.started_at,
        stage.finished_at ?? end,
        stage.stage === "bronze" ? "load" : "transform",
        label,
        JSON.stringify([stage.stage, stage.attempt])
      );
    }
  }
  const failures = run.stages
    .filter((stage) => ["failed", "wait_timeout"].includes(stage.status))
    .map((stage) => {
      const stageName = t(`connectors.runs.stage.${stage.stage}`, {
        defaultValue: stage.stage,
      });
      const label = t("connectors.runs.failed_stage", { stage: stageName });
      return {
        stage,
        label,
        offset: elapsedMs(stage.finished_at ?? "", run.started_at),
      };
    });
  if (!bands.length && !failures.length && !(span && run.stages.length))
    return null;
  bands.sort((a, b) => a.start - b.start);
  const gaps: typeof bands = [];
  const starts = run.stages.flatMap((stage) => {
    if (
      !stage.granted_at ||
      (!stage.started_at &&
        !(stage.status === "starting" && !run.finished_at)) ||
      stage.stage === "connector-checks"
    )
      return [];
    const start = elapsedMs(stage.granted_at, run.started_at);
    const stop = elapsedMs(stage.started_at ?? end, run.started_at);
    if (start == null || stop == null || stop <= start) return [];
    const name = t(`connectors.runs.stage.${stage.stage}`, {
      defaultValue: stage.stage,
    });
    return [
      {
        start,
        stop,
        label: t("connectors.runs.before_start", { stage: name }),
      },
    ];
  });
  const measuredStages = run.stages.filter(
    (s) => s.stage !== "connector-checks"
  );
  const stageWindows = measuredStages.map((s) => ({
    queued: elapsedMs(s.queued_at ?? "", run.started_at),
    granted: elapsedMs(s.granted_at ?? "", run.started_at),
    started: elapsedMs(s.started_at ?? "", run.started_at),
    finished: elapsedMs(s.finished_at ?? "", run.started_at),
  }));
  function gapName(from: number, to: number) {
    if (
      stageWindows.some(
        (s) =>
          s.queued != null &&
          from >= s.queued &&
          s.granted != null &&
          to <= s.granted
      )
    )
      return "admission_decision";
    if (
      stageWindows.length &&
      stageWindows.every((s) => s.queued != null && to <= s.queued)
    )
      return "before_first";
    if (
      run.finished_at &&
      stageWindows.length &&
      stageWindows.every((s) => s.finished != null && from >= s.finished)
    )
      return run.status === "cancelled" ? "until_cancelled" : "after_last";
    if (
      stageWindows.some((s) => s.finished != null && from >= s.finished) &&
      stageWindows.some((s) => s.queued != null && to <= s.queued) &&
      !stageWindows.some(
        (s) =>
          s.queued != null &&
          s.queued < to &&
          s.started == null &&
          (s.finished == null || s.finished > from)
      )
    )
      return "between_stages";
    return "no_stage_timing";
  }
  function addGap(start: number, stop: number) {
    if (stop <= start) return;
    const edges = [
      ...new Set([
        start,
        stop,
        ...starts
          .flatMap((s) => [s.start, s.stop])
          .filter((x) => x > start && x < stop),
        ...stageWindows
          .flatMap((s) => [s.queued, s.granted, s.finished])
          .filter((x): x is number => x != null && x > start && x < stop),
      ]),
    ].sort((a, b) => a - b);
    for (let i = 1; i < edges.length; i++) {
      const from = edges[i - 1],
        to = edges[i];
      const labels = starts
        .filter((s) => s.start <= from && to <= s.stop)
        .map((s) => s.label);
      const phase = gapName(from, to);
      const label = labels.length
        ? labels.join(", ")
        : t(`connectors.runs.${phase}`);
      const clock = (offset: number) =>
        new Date(Date.parse(run.started_at) + offset)
          .toISOString()
          .slice(11, to - from < 1000 ? 23 : 19);
      gaps.push({
        start: from,
        end: to,
        kind: labels.length
          ? "startup"
          : phase === "no_stage_timing"
            ? "unknown"
            : "gap",
        label: [
          `${clock(from)}–${clock(to)} UTC`,
          label,
          formatDuration(to - from),
        ].join(" · "),
      });
    }
  }
  let covered = 0;
  for (const band of bands) {
    addGap(covered, band.start);
    covered = Math.max(covered, band.end);
  }
  addGap(covered, span);
  const lanes: number[] = [];
  const segments = [...bands, ...gaps]
    .sort((a, b) => a.start - b.start)
    .map((band) => {
      const free = lanes.findIndex((previousEnd) => previousEnd <= band.start);
      const lane = free < 0 ? lanes.length : free;
      lanes[lane] = band.end;
      return { ...band, lane };
    });
  return (
    <figure className="space-y-2" aria-label={t("connectors.runs.stage_band")}>
      <div
        className="relative rounded-sm bg-muted/50"
        style={{ height: lanes.length * 14 }}
      >
        {segments.map(({ start, end, kind, label, lane }) => (
          <Tooltip key={`${start}-${lane}`}>
            <TooltipTrigger
              render={<span tabIndex={0} />}
              aria-label={label}
              className={cn(
                "absolute h-3 min-w-px rounded-sm border-r border-background focus-visible:outline-2",
                colors[kind]
              )}
              style={{
                left: `${(100 * start) / span}%`,
                width: `${(100 * (end - start)) / span}%`,
                top: lane * 14,
              }}
            />
            <TooltipContent role="tooltip">{label}</TooltipContent>
          </Tooltip>
        ))}
        {failures.map(
          ({ stage, offset, label }) =>
            offset != null &&
            span > 0 &&
            offset <= span && (
              <Tooltip key={stage.stage + stage.attempt}>
                <TooltipTrigger
                  type="button"
                  aria-label={label}
                  className="absolute z-10 grid size-5 -translate-x-1/2 -translate-y-1/2 cursor-help place-items-center rounded-full border-0 bg-transparent p-0 focus-visible:outline-2"
                  style={{
                    left: `${(100 * offset) / span}%`,
                    top:
                      (segments.find(
                        (s) =>
                          s.stageKey ===
                          JSON.stringify([stage.stage, stage.attempt])
                      )?.lane ?? 0) *
                        14 +
                      6,
                  }}
                >
                  <span className="grid size-4 place-items-center rounded-full bg-destructive text-(--destructive-foreground)">
                    <X className="size-3" strokeWidth={3} aria-hidden="true" />
                  </span>
                </TooltipTrigger>
                <TooltipContent role="tooltip">
                  {label} · {formatStarted(stage.finished_at)}
                  <br />
                  {stageFailureReason(stage)}
                </TooltipContent>
              </Tooltip>
            )
        )}
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {(["wait", "load", "transform"] as const)
          .filter((kind) => bands.some((band) => band.kind === kind))
          .map((kind) => (
            <span key={kind} className="inline-flex items-center gap-1.5">
              <i
                aria-hidden="true"
                className={cn("size-2 rounded-sm", colors[kind])}
              />
              {t(`connectors.runs.${kind}`)} ·{" "}
              {formatDuration(run[`${kind}_ms`])}
            </span>
          ))}
        {(["startup", "gap", "unknown"] as const).map((kind) => {
          const duration = gaps
            .filter((g) => g.kind === kind)
            .reduce((sum, g) => sum + (g.end - g.start), 0);
          return (
            duration > 0 && (
              <span key={kind} className="inline-flex items-center gap-1.5">
                <i
                  aria-hidden="true"
                  className={cn("size-2 rounded-sm", colors[kind])}
                />
                {t(
                  kind === "unknown"
                    ? "connectors.runs.missing_timing"
                    : `connectors.runs.${kind}`
                )}{" "}
                · {formatDuration(duration)}
              </span>
            )
          );
        })}
        {failures.map(({ stage, label }) => (
          <strong
            className="basis-full text-destructive"
            key={stage.stage + stage.attempt}
          >
            {stage.finished_at && <>{formatStarted(stage.finished_at)} · </>}
            {label}
            {stage.attempt > 1 && (
              <> · {t("connectors.runs.attempt", { number: stage.attempt })}</>
            )}
          </strong>
        ))}
      </figcaption>
    </figure>
  );
}
