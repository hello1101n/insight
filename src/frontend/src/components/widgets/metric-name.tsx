import { cn } from "@/lib/utils";

export interface MetricNameProps {
  metric: { label: string };
  text?: string;
  className?: string;
  truncate?: boolean;
}

export function MetricName({
  metric,
  text,
  className,
  truncate = false,
}: MetricNameProps) {
  const label = text ?? metric.label;
  const shortenedFrom = label === metric.label ? undefined : metric.label;
  const cut = truncate || shortenedFrom != null;

  return (
    <>
      <span
        title={cut ? metric.label : undefined}
        className={cn(truncate && "min-w-0 truncate", className)}
      >
        {label}
      </span>
      {/* INVARIANT: assistive technology does not reliably read `title` on a
          span, so the full form of a shortened name goes to it here. */}
      {shortenedFrom ? <span className="sr-only">{shortenedFrom}</span> : null}
    </>
  );
}
