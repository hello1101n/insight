export const CHART_PALETTE = [
  "var(--chart-5)",
  "var(--chart-4)",
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-2)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)",
  "var(--chart-11)",
  "var(--chart-12)",
] as const;

export function chartColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length]!;
}
