import type { CSSProperties } from 'react';

// The kit chart container stretched over its cell, with no aspect ratio of its own: the cartesian, pie, radar and
// waterfall charts fill the box the cell gives them.
export const FILL = { '--chart-aspect-ratio': 'auto', blockSize: '100%', inlineSize: '100%' } as CSSProperties;

// Tick text in the chart's chrome colour: Recharts paints it #666, which fails contrast on a dark card.
export const TICK = { fill: 'var(--muted-foreground)' };

// About the width of one tick character at the kit chart's tick size, and the height of a tick line with a gap: the
// estimates the cartesian and the radar charts judge their tick labels with.
export const TICK_CHAR_WIDTH = 6.5;
export const TICK_TEXT_HEIGHT = 15;

/**
 * The row a click on a chart picks: the index of the hovered band, axis or point, or null for a click outside any,
 * which carries no index and must not pick row 0.
 */
export function pickIndexOf(state: { activeTooltipIndex?: number | string | null }): number | null {
  if (state.activeTooltipIndex === null || state.activeTooltipIndex === undefined) return null;
  const index = Number(state.activeTooltipIndex);
  return Number.isInteger(index) && index >= 0 ? index : null;
}
