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
