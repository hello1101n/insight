import type { MetricFormat } from "@/api/metric-results-client";
import { formatMetricValue } from "@/lib/format";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@gears-frontx/ui-kit";
import { peerSpread, type PeerStanding } from "@/lib/metrics/peer-standing";
import { cn } from "@/lib/utils";

const MAX_SPREADS = 2.5;

const W = 112;
const H = 20;
const PAD = 5;

export const PEER_MARK_CENTRE = W / 2;

function x(spreads: number): number {
  const clamped = Math.max(-MAX_SPREADS, Math.min(MAX_SPREADS, spreads));
  return W / 2 + (clamped / MAX_SPREADS) * (W / 2 - PAD);
}

export function PeerMark({
  standing,
  metricLabel,
  format,
  unit,
  className,
}: {
  standing: PeerStanding;
  metricLabel: string;
  format: MetricFormat;
  unit?: string | null;
  className?: string;
}) {
  const show = (value: number) => formatMetricValue(value, format, unit);
  const spreads =
    standing.eligible && standing.stats
      ? standing.gapDelta / peerSpread(standing.stats)
      : null;
  const pinned = spreads != null && Math.abs(spreads) > MAX_SPREADS;
  const adverse = standing.rank === "bottom";
  const markClass = adverse ? "text-destructive" : "text-muted-foreground";

  const svg = (
    <svg
      data-slot="peer-mark"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className={cn("shrink-0 overflow-visible", className)}
      role="img"
      aria-label={describe(spreads, metricLabel)}
    >
      {[-1, 1].map((side) => (
        <line
          key={side}
          x1={x(side)}
          y1={H - 3}
          x2={x(side)}
          y2={H}
          stroke="currentColor"
          strokeWidth={1}
          className="text-muted-foreground"
        />
      ))}
      {spreads == null ? null : pinned ? (
        <path
          d={
            spreads > 0
              ? `M${W - PAD - 4},${H / 2 - 3.5} L${W - PAD + 1},${H / 2} L${W - PAD - 4},${H / 2 + 3.5} Z`
              : `M${PAD + 4},${H / 2 - 3.5} L${PAD - 1},${H / 2} L${PAD + 4},${H / 2 + 3.5} Z`
          }
          fill="currentColor"
          className={markClass}
        />
      ) : (
        <circle
          cx={x(spreads)}
          cy={H / 2}
          r={3}
          fill="currentColor"
          className={markClass}
        />
      )}
    </svg>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{svg}</span>} />
      <TooltipContent
        side="top"
        className="flex-col items-start text-left"
      >
        <p>{describe(spreads, metricLabel)}</p>
        {standing.stats ? (
          <p className="text-background/70">
            {standing.stats.n} compared · middle {show(standing.stats.p50)} ·
            middle half {show(standing.stats.p25)}–{show(standing.stats.p75)}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

function describe(spreads: number | null, metricLabel: string): string {
  if (spreads == null) return `${metricLabel}: nothing comparable in the group`;
  const size = Math.abs(spreads).toFixed(1);
  const side = spreads > 0 ? "above" : "below";
  if (Math.abs(spreads) < 0.05) return `${metricLabel}: at the group's middle`;
  return `${metricLabel}: ${size} spreads ${side} the group's middle`;
}
