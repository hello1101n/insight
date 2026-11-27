const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A `YYYY-MM-DD` date as its UTC midnight in milliseconds, or null when it is not such a date of the calendar. The one date
 * rule of the widgets: the heatmap calendar, and the bare dates of cartesian points and reference lines on a time axis.
 */
export function dayOf(x: unknown): number | null {
  if (typeof x !== 'string') return null;
  const match = ISO_DATE.exec(x);
  if (!match) return null;
  // setUTCFullYear takes the year as it is, where Date.UTC would read the years 0 to 99 as 1900 to 1999.
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // It rolls 2026-02-30 over into March: a date that does not read back as itself is no date.
  return date.toISOString().slice(0, 10) === x ? date.getTime() : null;
}

/**
 * An ISO 8601 date-time: a calendar date, a T, a time of day (hour 00 to 23, minute 00 to 59), an optional second
 * (00 to 59) with its fraction and an optional zone. The zone is Z or an offset of two hour digits with optional
 * two minute digits, written +hh:mm, +hhmm or +hh, each with its minus form. Hour 24 is no time of day here:
 * Date.parse reads T24:00 as the next midnight, which would move the item to another day.
 */
export const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/**
 * An ISO 8601 date-time with its offset written as +hh:mm, the one form every engine reads and HTML takes: +hhmm takes
 * its colon and a bare +hh takes the minutes 00, while Z and no zone stay as they are, and a bare `YYYY-MM-DD` date
 * stays as it is.
 */
export function dateTimeOf(time: string): string {
  const dateTime = ISO_DATE_TIME.exec(time);
  if (!dateTime) return time;
  const zone = dateTime[4] ?? '';
  if (zone === '') return time;
  const offset = zone.replace(/^([+-])(\d{2})$/, '$1$2:00').replace(/^([+-])(\d{2})(\d{2})$/, '$1$2:$3');
  return offset === zone ? time : `${time.slice(0, -zone.length)}${offset}`;
}

/**
 * The one time reader of the widgets: a time string as epoch milliseconds. An ISO 8601 date-time reads as it is,
 * once its date part is a day of the calendar (Date.parse rolls 2026-02-30T10:00:00Z over into March, so the date part
 * goes through the calendar rule of dayOf first), and a bare `YYYY-MM-DD` date reads as its UTC midnight by that
 * rule. Null for anything else, including a day the calendar does not have, alone or before a time of day.
 */
export function timeOf(time: string): number | null {
  if (!ISO_DATE_TIME.test(time)) return dayOf(time);
  if (dayOf(time.slice(0, 10)) === null) return null;
  // The offset is written as +hh:mm before parsing, the one form every engine reads.
  const parsed = Date.parse(dateTimeOf(time));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * A date formatter that writes the era for a date before the year 1. Intl writes the year 0 (1 BC) as "1", the same
 * as the year 1, and takes no era beside `dateStyle`; such a date is written instead by the components of the medium
 * date style (and of the time style asked) with the short era, as "Jan 1, 1 BC", read in the same zone. Every later
 * date, and a formatter that writes no year, keeps the formatter as asked.
 */
export function dateFormatOf(locale: string, options: Intl.DateTimeFormatOptions): (time: number) => string {
  const asked = new Intl.DateTimeFormat(locale, options);
  const { dateStyle, timeStyle, ...rest } = options;
  if (dateStyle === undefined && rest.year === undefined) return (time) => asked.format(time);
  const early = new Intl.DateTimeFormat(locale, {
    ...rest,
    ...(dateStyle === undefined ? {} : { year: 'numeric', month: 'short', day: 'numeric' }),
    ...(timeStyle === undefined ? {} : { hour: 'numeric', minute: '2-digit', ...(timeStyle === 'short' ? {} : { second: '2-digit' }) }),
    era: 'short',
  });
  const utc = asked.resolvedOptions().timeZone === 'UTC';
  return (time) => ((utc ? new Date(time).getUTCFullYear() : new Date(time).getFullYear()) < 1 ? early : asked).format(time);
}
