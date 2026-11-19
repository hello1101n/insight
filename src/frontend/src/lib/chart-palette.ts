/**
 * Chart series colours in the order series take them. The kit's five tokens
 * come first, ordered so the first series is blue rather than the kit's red
 * and no neighbours are red and green; `--chart-6` to `--chart-10` extend
 * them in index.css. Past ten, colours repeat.
 */
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
] as const;

export function chartColor(index: number): string {
  return CHART_PALETTE[index % CHART_PALETTE.length]!;
}
