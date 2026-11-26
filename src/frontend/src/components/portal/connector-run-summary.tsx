import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@gears-frontx/ui-kit";

import type { ConnectorRun } from "@/api/connector-health-client";
import {
  formatDuration,
  type ConnectorTone,
} from "@/lib/portal/connector-health";
import { summarizeRun } from "@/lib/portal/connector-run-timing";
import { describeRunState } from "@/lib/portal/connector-run-view";
import {
  isActiveRun,
  queueDetails,
  stepDetail,
  stepLabel,
} from "@/lib/portal/connector-runs";
import { TONE_BADGE } from "./connector-health-tone";
import { ConnectorRunState, RunTooltip } from "./connector-run-state";
import { ConnectorRunPeriod } from "./connector-timestamp";

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
    <section className="min-w-0 py-1">
      <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
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
          <p className="text-xs text-muted-foreground tabular-nums">
            {run ? (
              <ConnectorRunPeriod
                startedAt={run.started_at}
                finishedAt={detailsOpen ? run.finished_at : null}
              />
            ) : (
              empty
            )}
          </p>
        </div>
        {run && metrics.length > 0 && (
          <CollapsibleContent>
            <dl className="mt-1 grid w-full grid-cols-[repeat(auto-fit,minmax(min(6rem,100%),1fr))] gap-2 border-t pt-1">
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
          </CollapsibleContent>
        )}
      </Collapsible>
    </section>
  );
}

export function ConnectorRunSummary({
  current,
  successful,
  asOf,
  className,
}: {
  current?: ConnectorRun | null;
  successful?: ConnectorRun | null;
  asOf: string;
  className: string;
}) {
  const { t } = useTranslation();
  if (!current && !successful) return null;

  return (
    <div className={className}>
      <RunMetrics
        title={t("connectors.runs.current")}
        empty={t("connectors.runs.no_current")}
        run={current && isActiveRun(current) ? current : null}
        asOf={asOf}
      />
      <RunMetrics
        title={t("connectors.runs.latest_success")}
        empty={t("connectors.runs.no_success")}
        run={successful}
        asOf={asOf}
      />
    </div>
  );
}
