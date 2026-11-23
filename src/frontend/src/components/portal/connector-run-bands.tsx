import { Tooltip, TooltipContent, TooltipTrigger } from "@gears-frontx/ui-kit";
import { X } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import {
  formatDuration,
  formatStarted,
  parseStamp,
} from "@/lib/portal/connector-health";
import type { RunTiming } from "@/lib/portal/connector-run-timing";
import {
  queueDetails,
  stageFailureDetails,
  stepDetail,
  stepLabel,
} from "@/lib/portal/connector-runs";
import { cn } from "@/lib/utils";
import { TONE_BAR_STYLE } from "./connector-health-tone";

const colors = {
  queued: "bg-muted-foreground/45",
  bronze: "bg-[light-dark(#a56642,#d69b78)]",
  silver: "bg-[light-dark(#61799e,#9bb6db)]",
  identity: "bg-[light-dark(#19867a,#58c1b3)]",
  gold: "bg-[light-dark(#7865b8,#b49af1)]",
};

export function ConnectorRunBands({ timing }: { timing: RunTiming }) {
  const { t } = useTranslation();
  const id = useId();
  const { start, end, segments, steps } = timing;
  if (
    start == null ||
    end == null ||
    end <= start ||
    (!segments.length && !steps.some((step) => step.failure))
  )
    return null;

  const span = end - start;
  const percent = (ms: number) => `${(100 * ms) / span}%`;
  const lanes: number[] = [];
  const bands = segments.map((segment) => {
    const free = lanes.findIndex((previousEnd) => previousEnd <= segment.start);
    const lane = free < 0 ? lanes.length : free;
    lanes[lane] = segment.end;
    return { ...segment, lane };
  });
  const labelFor = (kind: keyof typeof colors) =>
    kind === "queued" ? t("connectors.runs.queued") : stepLabel(kind);
  const kinds = (Object.keys(colors) as (keyof typeof colors)[]).filter(
    (kind) => segments.some((segment) => segment.kind === kind)
  );

  return (
    <figure className="space-y-2" aria-label={t("connectors.runs.step_band")}>
      <div
        className="relative rounded-sm bg-muted/50"
        style={{ height: Math.max(lanes.length, 1) * 14 }}
      >
        {bands.map((band) => {
          const { start: from, end: to, kind, lane } = band;
          const tooltipId = `${id}-${from}-${lane}`;
          const label = [
            formatStarted(new Date(from).toISOString()),
            labelFor(kind),
            formatDuration(to - from),
          ].join(" · ");
          const details =
            band.kind === "queued"
              ? queueDetails(band.reasons, band.tone)
              : [stepDetail(band.kind)];
          const color =
            band.kind === "queued" && band.tone !== "idle"
              ? TONE_BAR_STYLE[band.tone]
              : colors[kind];
          return (
            <Tooltip key={`${from}-${lane}`}>
              <TooltipTrigger
                render={<span tabIndex={0} />}
                aria-label={label}
                aria-describedby={details.length ? tooltipId : undefined}
                className={cn(
                  "absolute h-3 min-w-px rounded-sm border-r border-background focus-visible:outline-2",
                  color
                )}
                style={{
                  left: percent(from - start),
                  width: percent(to - from),
                  top: lane * 14,
                }}
              />
              <TooltipContent id={tooltipId} role="tooltip">
                <div className="flex flex-col gap-1">
                  <span aria-hidden="true">{label}</span>
                  {details.map((detail) => (
                    <span key={detail}>{detail}</span>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
        {steps.map(({ step, failure }) => {
          const timedOut = failure?.status === "wait_timeout";
          const at =
            parseStamp(failure?.finished_at) ?? (timedOut ? end : null);
          if (!failure || at == null || at < start || at > end) return null;

          const lane =
            bands.find(
              (band) =>
                (band.kind === step || (timedOut && band.kind === "queued")) &&
                band.start <= at &&
                at <= band.end
            )?.lane ?? 0;
          const tooltipId = `${id}-failed-${step}`;
          const label = t("connectors.runs.failed_step", {
            step: stepLabel(step),
          });
          return (
            <Tooltip key={step}>
              <TooltipTrigger
                type="button"
                aria-label={label}
                aria-describedby={tooltipId}
                className="absolute z-10 grid size-6 -translate-x-1/2 -translate-y-1/2 cursor-help place-items-center rounded-full border-0 bg-transparent p-0 focus-visible:outline-2"
                style={{
                  left: `clamp(12px, ${percent(at - start)}, calc(100% - 12px))`,
                  top: lane * 14 + 6,
                }}
              >
                <span className="grid size-4 place-items-center rounded-full bg-destructive text-(--destructive-foreground)">
                  <X className="size-3" strokeWidth={3} aria-hidden="true" />
                </span>
              </TooltipTrigger>
              <TooltipContent id={tooltipId} role="tooltip">
                <div className="flex flex-col gap-1">
                  <span>
                    <span aria-hidden="true">{label} · </span>
                    {formatStarted(new Date(at).toISOString())}
                  </span>
                  {stageFailureDetails(failure).map((detail) => (
                    <span key={detail}>{detail}</span>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {kinds.map((kind) => (
          <span className="inline-flex items-center gap-1.5" key={kind}>
            <i
              aria-hidden="true"
              className={cn("size-2 rounded-sm", colors[kind])}
            />
            {labelFor(kind)}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
