export type Status = "good" | "warn" | "bad" | "neutral"

export const STATUS_BG_CLASS: Record<Status, string> = {
  good: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  neutral: "bg-muted-foreground/40",
}

export const STATUS_TEXT_CLASS: Record<Status, string> = {
  good: "text-success",
  warn: "text-warning",
  bad: "text-destructive",
  neutral: "text-muted-foreground",
}

export const STATUS_SURFACE_CLASS: Record<Status, string> = {
  good: "bg-success/15 text-success",
  warn: "bg-warning/15 text-warning",
  bad: "bg-destructive/15 text-destructive",
  neutral: "bg-muted text-muted-foreground",
}

/**
 * Value-form status colors for contexts where a Tailwind class can't be used —
 * e.g. SVG `fill` on recharts cells. Mirrors the class maps above so the two
 * stay in lockstep.
 */
export const STATUS_COLOR_VAR: Record<Status, string> = {
  good: "var(--success)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
  neutral: "var(--muted-foreground)",
}

/** Score a value against a reference median, given metric direction. */
export function statusVsMedian(
  value: number,
  median: number,
  higherIsBetter: boolean
): Status {
  // A median of 0 is a legitimate comparison point (e.g. a low-activity
  // cohort); "no comparison" is expressed as a null median upstream, not 0.
  if (!Number.isFinite(value) || !Number.isFinite(median)) {
    return "neutral"
  }
  return (higherIsBetter ? value >= median : value <= median) ? "good" : "bad"
}

