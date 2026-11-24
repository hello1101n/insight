import { cn } from "@/lib/utils";

export interface SparklineProps {
  points: (number | null)[];
  className?: string;
}

const W = 72;
const H = 16;

export function Sparkline({ points, className }: SparklineProps) {
  const values = points.filter((v) => v != null);
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - ((v - min) / span) * H;

  const segments: string[] = [];
  let run: string[] = [];
  points.forEach((v, i) => {
    if (v == null) {
      if (run.length > 1) segments.push(run.join(" "));
      run = [];
      return;
    }
    run.push(`${run.length ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (run.length > 1) segments.push(run.join(" "));

  const lastIndex = points.findLastIndex((v) => v != null);
  const lastValue = points[lastIndex];

  return (
    <svg
      data-slot="sparkline"
      viewBox={`0 0 ${W} ${H + 3}`}
      width={W}
      height={H + 3}
      className={cn("overflow-visible text-muted-foreground", className)}
      aria-hidden
    >
      <line
        x1={0}
        y1={H + 2}
        x2={W}
        y2={H + 2}
        stroke="currentColor"
        strokeWidth={0.75}
        className="text-muted-foreground"
      />
      <line
        x1={0}
        y1={H}
        x2={0}
        y2={H + 3}
        stroke="currentColor"
        strokeWidth={0.75}
        className="text-muted-foreground"
      />
      <line
        x1={W}
        y1={H}
        x2={W}
        y2={H + 3}
        stroke="currentColor"
        strokeWidth={0.75}
        className="text-muted-foreground"
      />
      {segments.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {lastValue != null ? (
        <circle
          cx={x(lastIndex)}
          cy={y(lastValue)}
          r={1.5}
          fill="currentColor"
        />
      ) : null}
    </svg>
  );
}
