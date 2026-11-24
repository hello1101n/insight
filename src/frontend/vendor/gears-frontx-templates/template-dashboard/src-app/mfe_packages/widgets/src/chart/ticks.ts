import type { ValueFormat } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue } from '../format';

/**
 * The tick text of a value axis, as the radar and the waterfall charts write it: the number in compact notation,
 * formatted by `value_format` without the unit word a plain number carries (`unit_label`), which the tooltip and the
 * data view write. A percent, a currency and a duration keep their unit, which the number format writes into the
 * number itself (12%, $1.2K, 26 hr).
 */
export function compactTick(value_format: ValueFormat | undefined, locale: string) {
  const bare = value_format ? { ...value_format, unit_label: undefined } : undefined;
  return (value: number) => formatValue(value, bare, locale, 'compact');
}

// A cut tick keeps this many characters, its ellipsis included, so a name this short (a YYYY-MM-DD date, a month) stays whole.
const MIN_CUT_TICK = 10;

/** A text cut to `length` characters, the last of them an ellipsis; a text no longer than that stays whole. */
function cut(text: string, length: number) {
  const characters = Array.from(text);
  return characters.length > length ? `${characters.slice(0, length - 1).join('')}…` : text;
}

/**
 * The tick text of each category label for a room of `room` characters: a longer label is cut with an ellipsis, to no
 * fewer than MIN_CUT_TICK characters, and kept longer where a shorter cut would make two different labels read alike.
 * A text not among the labels stays whole.
 */
export function cutTicks(labels: string[], room: number): (text: string) => string {
  const distinct = [...new Set(labels)];
  for (let length = Math.max(MIN_CUT_TICK, Math.floor(room)); ; length += 1) {
    const cuts = new Map(distinct.map((label) => [label, cut(label, length)]));
    if (new Set(cuts.values()).size === distinct.length) return (text) => cuts.get(text) ?? text;
  }
}
