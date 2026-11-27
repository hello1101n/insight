import { useLayoutEffect, useRef, useState } from 'react';

// About the width of one character and the height of one line for their font size, and the share of the hole's radius
// the centre text may reach: the text block's corners stay inside that circle. The character width is only the first
// guess: each drawn line is then measured, and its measured width replaces the guess.
export const CHAR_WIDTH = 0.62;
export const LINE_HEIGHT = 1.2;
export const HOLE_ROOM = 0.9;
// Smaller than this, a centre line is left out.
export const FLOOR_SIZE = 9;

/** The estimated width in px of a text drawn at a font size of px: CHAR_WIDTH of the size per character. */
export const estimateWidth = (text: string, px: number) => text.length * CHAR_WIDTH * px;

/** One line of centre text: its role (the `data-role` it is drawn with), its text and its largest font size. */
export interface CentreLine {
  role: string;
  text: string;
  size: number;
}

/** The measured width of each drawn centre line, in em of its font size, by role, with the text it was measured for. */
export type MeasuredLines = Partial<Record<string, { text: string; em: number }>>;

/**
 * The centre lines that fit a round hole of radius `hole`, in the given order: the whole text block scaled down by one
 * factor until its corners are inside it, never above each line's own size. When a line would then fall under the
 * readable floor, the last line is left out and the rest is sized again. A line's width is its measured width when
 * the same text was measured, else the estimate. Empty lines are dropped first.
 */
export function fitCentreLines<Line extends CentreLine>(hole: number, wanted: Line[], measured: MeasuredLines): Line[] {
  const room = hole * HOLE_ROOM;
  const emOf = (line: Line) => emOfLine(line, measured);
  let lines = wanted.filter((line) => line.text !== '');
  while (lines.length > 0) {
    const width = Math.max(...lines.map((line) => emOf(line) * line.size));
    const height = lines.reduce((total, line) => total + line.size * LINE_HEIGHT, 0);
    const scale = Math.min(1, room / Math.hypot(width / 2, height / 2));
    const sized = lines.map((line) => ({ ...line, size: line.size * scale }));
    if (sized.every((line) => line.size >= FLOOR_SIZE)) return sized;
    lines = lines.slice(0, -1);
  }
  return [];
}

/** A line's width in em of its font size: its measured width when the same text was measured, else the estimate. */
function emOfLine({ role, text }: CentreLine, measured: MeasuredLines) {
  const known = measured[role];
  return known?.text === text ? known.em : estimateWidth(text, 1);
}

/**
 * One line set in a straight run `width` wide: at its own size, or smaller when it is wider than the run, by the same
 * measured or estimated width as the centre lines. Null when it would fall under the readable floor.
 */
export function fitLine<Line extends CentreLine>(width: number, line: Line, measured: MeasuredLines): Line | null {
  const em = emOfLine(line, measured);
  const size = em > 0 ? Math.min(line.size, width / em) : line.size;
  return line.text !== '' && size >= FLOOR_SIZE ? { ...line, size } : null;
}

/**
 * Measures the drawn centre lines after each render: every `text[data-role]` inside the element the returned ref is
 * put on (an `svg` or a `g`) is measured with `getComputedTextLength()`. A width other than the one known for that
 * text renders again, so `fitCentreLines` sizes by what was really drawn and a line that does not fit is left out. A
 * document that lays nothing out measures nothing and keeps the estimate.
 */
export function useMeasuredLines<Element extends SVGElement>() {
  const ref = useRef<Element>(null);
  const [measured, setMeasured] = useState<MeasuredLines>({});
  // No dependency list: the drawn lines are read after every render; state changes only when a width does.
  useLayoutEffect(() => {
    const next: MeasuredLines = { ...measured };
    let changed = false;
    for (const text of ref.current?.querySelectorAll<SVGTextElement>('text[data-role]') ?? []) {
      const length = typeof text.getComputedTextLength === 'function' ? text.getComputedTextLength() : 0;
      if (!(length > 0)) continue;
      const role = text.getAttribute('data-role') ?? '';
      const em = length / Number(text.getAttribute('font-size'));
      const known = next[role];
      // A small tolerance, so font hinting at a new size cannot size the lines again and again.
      if (known && known.text === text.textContent && Math.abs(known.em - em) <= known.em * 0.02) continue;
      next[role] = { text: text.textContent ?? '', em };
      changed = true;
    }
    if (changed) setMeasured(next);
  });
  return [ref, measured] as const;
}
