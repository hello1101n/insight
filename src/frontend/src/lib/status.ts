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

export const STATUS_COLOR_VAR: Record<Status, string> = {
  good: "var(--success)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
  neutral: "var(--muted-foreground)",
}

export function statusVsMedian(
  value: number,
  median: number,
  higherIsBetter: boolean
): Status {
  if (!Number.isFinite(value) || !Number.isFinite(median)) {
    return "neutral"
  }
  return (higherIsBetter ? value >= median : value <= median) ? "good" : "bad"
}

