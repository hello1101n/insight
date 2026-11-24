import { intlLocaleOf, type ValueFormat } from '@gears-frontx/frontx-dashboard-root/contract';

const UNIT: Record<string, Intl.NumberFormatOptions['unit']> = { ms: 'millisecond', s: 'second', min: 'minute', h: 'hour', d: 'day' };

/** The Intl options of a value format; `decimals` fixes the fraction digits of every value type. */
function optionsOf(format: ValueFormat | undefined): Intl.NumberFormatOptions {
  const digits = format?.decimals === undefined ? {} : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals };
  if (format?.value_type === 'percent') return { style: 'percent', maximumFractionDigits: 2, ...digits };
  if (format?.value_type === 'duration' && Object.hasOwn(UNIT, format.unit)) return { style: 'unit', unit: UNIT[format.unit], ...digits };
  if (format?.value_type === 'currency') return { style: 'currency', currency: format.currency, ...digits };
  return digits;
}

/**
 * A share (a part over its whole, 1 is all of it) as a percent, snapped to 12 significant digits. The arithmetic that
 * made the share carries binary error (29 / 100 * 100 is 28.999999999999996), so a rounding rule applied to the raw
 * number can land one step off (29 of 100 rounded down to 28%). Every place that shows or announces a share as a
 * percent goes through here; the caller keeps its own rounding rule (down, nearest, a number of decimals) and applies
 * it to the snapped percent. A share whose percent is beyond the largest number gives an infinity.
 */
export function percentOfShare(share: number): number {
  return Number((share * 100).toPrecision(12));
}

/** A share's percent rounded to the nearest hundredth, before any clamp: the one number a mark stands at and the outside test judges. */
const percentInHundredths = (share: number): number => Math.round(percentOfShare(share * 100)) / 100;

/**
 * A share as a percent of a drawn range, 0 to 100: the snapped percent rounded to the nearest hundredth, never beyond
 * either end, and 100 for one that overflows. The one rule for where a bar, a ring or a goal mark stands.
 */
export function percentInRange(share: number): number {
  return Math.max(0, Math.min(100, percentInHundredths(share)));
}

// The most a bar or a ring below its target fills and announces: one rounding step short of full.
const BELOW_TARGET_MAX = 99.99;

/**
 * A share of a target (current over target) as a bar or a ring draws it: `reached` when the share snapped to 15
 * significant digits is at least 1, `over` when it is above 1 by the same snap, and `filled`, the percent in range,
 * at most 99.99 below reached, so the drawing, `aria-valuenow` and the text agree. The snap is finer than the
 * 12-digit display snap on purpose: a binary error of an exact share (0.3 of 0.1 + 0.2) lies far below 15 digits and
 * counts as reached, while a share a hair below the target (2999999999999 of 3000000000000) stays below.
 */
export function progressOf(share: number): { reached: boolean; over: boolean; filled: number } {
  const snapped = Number(share.toPrecision(15));
  const reached = snapped >= 1;
  const filled = percentInRange(share);
  return { reached, over: snapped > 1, filled: reached ? filled : Math.min(filled, BELOW_TARGET_MAX) };
}

/**
 * Whether a goal's share of its target lies outside the drawn range: its percent rounded to hundredths, before the
 * clamp, is below 0 or above 100. That is the number its tick or mark stands at, so a goal drawn on an end is inside.
 */
export function isOutsideRange(share: number): boolean {
  const percent = percentInHundredths(share);
  return percent < 0 || percent > 100;
}

/**
 * A share as a percent formatter writes it, rounded by the formatter's own rule on the snapped percent. The formatter
 * gets that percent shifted back two places as a decimal string, which Intl reads exactly: a number would carry the
 * binary error again (1.005% is no double, so it would round to 1%). An engine without string input reads it as a number.
 */
export function formatShare(formatter: Intl.NumberFormat, share: number): string {
  const percent = percentOfShare(share);
  if (!Number.isFinite(percent)) return formatter.format(share);
  const [digits, exponent = '0'] = String(percent).split('e');
  // Intl takes a decimal string since ES2023; the project's lib (ES2022) types only numbers.
  return formatter.format(`${digits}e${Number(exponent) - 2}` as unknown as number);
}

/**
 * A number as the widget shows it: by `value_format`, for the host language. Null is an empty value, and so is a
 * number that is not finite (a derived one can overflow): the text never shows `∞` or `NaN`, and a caller leaves
 * the empty part out. A percent value is a share, written through the shared share-to-percent helper. A shown zero
 * never carries a sign: a value that only rounds to zero (-2.78e-17, -0.004 at 2 decimals) reads 0, not -0. Intl's
 * `signDisplay: 'negative'` does that, but the project's lib (ES2022) does not type it and an engine without it
 * throws, so a text equal to the formatter's own negative zero is replaced by its zero.
 */
export function formatValue(value: number | null | undefined, format: ValueFormat | undefined, locale: string, notation?: 'standard' | 'compact'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  const formatter = new Intl.NumberFormat(intlLocaleOf(locale), { ...optionsOf(format), notation });
  const shown = format?.value_type === 'percent' ? formatShare(formatter, value) : formatter.format(value);
  const text = shown === formatter.format(-0) ? formatter.format(0) : shown;
  // A no-break space keeps the unit word on the number's line.
  return format?.value_type === 'number' && format.unit_label ? `${text} ${format.unit_label}` : text;
}

/**
 * The relative change of `value` from `base` (`(value - base) / |base|`), computed from halves when the difference
 * itself overflows (1.5e308 against -1.5e308 is a change of -200%). Not finite when the true change is beyond the
 * largest number (1 against 1e-320); the caller leaves that part out. `base` is not 0.
 */
export function relativeChangeOf(value: number, base: number): number {
  const difference = value - base;
  return Number.isFinite(difference) ? difference / Math.abs(base) : ((value / 2 - base / 2) / Math.abs(base)) * 2;
}

/** Any delivered value as text: numbers by `value_format`, the rest as given. */
export function textOf(value: string | number | null | undefined, format: ValueFormat | undefined, locale: string): string {
  return typeof value === 'number' ? formatValue(value, format, locale) : (value ?? '');
}

/**
 * The widget's own check that every number it was given is finite: the first NaN, Infinity or -Infinity in the
 * render, the data or the value format (a transform can compute one, and the data type accepts it), named by its
 * field path and positions, such as `data.rows[3].value`; never by its value, which is delivered data. Null when none.
 */
export function nonFiniteProblemOf(widget: string, payload: { render?: unknown; data?: unknown; value_format?: unknown }): string | null {
  const pathOf = (value: unknown, path: string): string | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? null : path;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const found = pathOf(value[index], `${path}[${index}]`);
        if (found) return found;
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        const found = pathOf(item, `${path}.${key}`);
        if (found) return found;
      }
    }
    return null;
  };
  const found = pathOf(payload.render, 'render') ?? pathOf(payload.data, 'data') ?? pathOf(payload.value_format, 'value_format');
  return found && `${widget}: ${found} is not a finite number`;
}
