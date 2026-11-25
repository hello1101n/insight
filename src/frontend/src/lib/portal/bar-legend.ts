import type { BarRow } from "@/lib/portal/bar-rows";
import { seriesColors } from "@/lib/series-colors";

export function segmentLegend(allRows: readonly BarRow[]) {
  const totals = new Map<string, { label: string; value: number }>();
  for (const row of allRows) {
    for (const segment of row.segments ?? []) {
      const seen = totals.get(segment.seed);
      totals.set(segment.seed, {
        label: seen?.label ?? segment.label,
        value: (seen?.value ?? 0) + segment.value,
      });
    }
  }
  const colors = seriesColors([...totals.keys()]);
  const legend = [...totals.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .map(([seed, { label }]) => ({ seed, label, color: colors[seed] }));
  return { colors, legend };
}
