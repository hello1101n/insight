export const HOUR_BLOCKS = Array.from({ length: 12 }, (_, i) =>
  String(i * 2).padStart(2, "0")
);

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export interface DayHourMatrix {
  cells: number[][];
  max: number;
  total: number;
}

export interface HourBlockSeries {
  dimensions: ReadonlyArray<{ key: string; value: string }>;
  points: ReadonlyArray<{ bucket_start: string; value: number | null }>;
}

export function dayHourMatrix(
  series: readonly HourBlockSeries[]
): DayHourMatrix {
  const cells = WEEKDAY_LABELS.map(() => HOUR_BLOCKS.map(() => 0));
  let max = 0;
  let total = 0;
  for (const entry of series) {
    const block = entry.dimensions.find((d) => d.key === "hour_block")?.value;
    const blockIndex = block == null ? -1 : HOUR_BLOCKS.indexOf(block);
    if (blockIndex < 0) continue;
    for (const point of entry.points) {
      if (point.value == null || point.value <= 0) continue;
      const day = new Date(`${point.bucket_start}T00:00:00Z`);
      if (Number.isNaN(day.getTime())) continue;
      const weekday = (day.getUTCDay() + 6) % 7;
      cells[weekday]![blockIndex]! += point.value;
      max = Math.max(max, cells[weekday]![blockIndex]!);
      total += point.value;
    }
  }
  return { cells, max, total };
}
