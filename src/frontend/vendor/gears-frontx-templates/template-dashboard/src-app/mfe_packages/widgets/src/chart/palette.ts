import type { Tone } from '../types';

// The kit's five series colours in an order that keeps neighbours apart, then three of its four categorical hues; a ninth
// series wraps to the first. --chart-category-blue is left out: it is the light theme's --chart-3.
export const PALETTE = [
  'var(--chart-5)',
  'var(--chart-4)',
  'var(--chart-2)',
  'var(--chart-1)',
  'var(--chart-3)',
  'var(--chart-category-purple)',
  'var(--chart-category-brown)',
  'var(--chart-category-teal)',
];

// The colour of a series of each tone: the kit's status colours, and its muted text colour for neutral.
export const TONE_COLORS: Record<Tone, string> = {
  neutral: 'var(--muted-foreground)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--danger)',
  info: 'var(--info)',
};
