export interface TagRow {
  widths: number[];
  available: number;
  gap: number;
  moreWidth: number;
  overflowing: boolean;
}

function rowWidth(widths: number[], gap: number): number {
  if (widths.length === 0) return 0;

  const chips = widths.reduce((sum, width) => sum + width, 0);
  return chips + gap * (widths.length - 1);
}

export function fittingCount({
  widths,
  available,
  gap,
  moreWidth,
  overflowing,
}: TagRow): number {
  if (widths.length === 0) return 0;
  if (!overflowing && rowWidth(widths, gap) <= available) return widths.length;

  let used = moreWidth;
  let count = 0;
  for (const width of widths) {
    used += gap + width;
    if (used > available) break;
    count += 1;
  }

  return Math.max(1, count);
}
