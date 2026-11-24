import type { ValueFormat } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue } from '../format';
import type { GridColumn, GridData, GridLink, GridRender, GridValue } from '../types';

export const DEFAULT_PAGE_SIZES = [10, 25, 50, 100, 500];

// @cpt-algo:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2
/** The grid's own consistency checks: the first problem found, or null. The text names keys and indexes, never data. */
export function checkGrid(render: GridRender, data: GridData): string | null {
  const keys = render.columns.map((column) => column.key);
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-dup-key
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated !== undefined) return `grid: column key ${repeated} repeats`;
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-dup-key

  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-for-group
  const owner = new Map<string, string>();
  for (const group of render.column_groups ?? []) {
    const unknown = group.members.find((key) => !keys.includes(key));
    if (unknown !== undefined) return `grid: group ${group.title} names ${unknown}, which is not a column`;
    const positions = [...new Set(group.members.map((key) => keys.indexOf(key)))].sort((a, b) => a - b);
    if (positions.some((position, index) => index > 0 && position !== positions[index - 1] + 1)) return `grid: group ${group.title} is not contiguous`;
    const twice = group.members.find((key, index) => group.members.indexOf(key) !== index);
    if (twice !== undefined) return `grid: group ${group.title} repeats ${twice}`;
    for (const key of group.members) {
      const other = owner.get(key);
      if (other !== undefined) return `grid: column ${key} is in groups ${other} and ${group.title}`;
      owner.set(key, group.title);
    }
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-for-group

  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-row-color
  if (render.row_color !== undefined && !keys.includes(render.row_color)) return `grid: row_color names ${render.row_color}, which is not a column`;
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-row-color

  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-kinds
  for (const column of render.columns) {
    if (column.tones !== undefined && column.kind !== 'badge') return `grid: column ${column.key} has tones but is not a badge column`;
    if (column.kind === 'sparkline' && column.sortable === true) return `grid: sparkline column ${column.key} is marked sortable`;
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-kinds

  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-positions
  const short = data.rows.findIndex((row) => row.length !== keys.length);
  if (short >= 0) return `grid: row ${short} does not have one value per column`;
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-positions

  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-values
  for (let row = 0; row < data.rows.length; row++) {
    for (let index = 0; index < keys.length; index++) {
      const problem = valueProblemOf(render.columns[index].kind ?? 'text', data.rows[row][index]);
      if (problem) return `grid: row ${row} column ${keys[index]} ${problem}`;
    }
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-grid-checks:p2:inst-wc-grid-values
  return null;
}

/** Why a value does not fit its column's kind, or null; the text never names the value, which is delivered data. */
function valueProblemOf(kind: NonNullable<GridColumn['kind']>, value: GridValue): string | null {
  if (value === null) return null;
  if (kind === 'sparkline') return Array.isArray(value) ? null : 'holds a value that is not a list';
  if (Array.isArray(value)) return 'holds a list outside a sparkline column';
  if (kind !== 'progress') return null;
  if (typeof value !== 'number') return 'holds a progress value that is not a number';
  // Written as the range it must be in, so NaN, which compares false, fails it too.
  return value >= 0 && value <= 1 ? null : 'holds a progress value outside 0 to 1';
}

/** Whether a header click sorts by the column: a sparkline column never sorts, any other unless `sortable` is false. */
export const isSortable = (column: GridColumn) => column.kind !== 'sparkline' && column.sortable !== false;

/**
 * The text a cell shows, which the search matches: a link's text, a number formatted by the column and the widget
 * format, a progress value as its percent (the column format does not apply), a string as it is; a sparkline shows none.
 */
export function shownTextOf(value: GridValue, column: GridColumn, valueFormat: ValueFormat | undefined, locale: string): string {
  if (column.kind === 'sparkline') return '';
  if (column.kind === 'progress') return typeof value === 'number' ? formatValue(value, { value_type: 'percent' }, locale) : '';
  if (isLink(value)) return value.text;
  if (typeof value === 'number') return formatValue(value, valueFormat, locale, column.format?.notation);
  return typeof value === 'string' ? value : '';
}

/** The rows whose shown text in any column contains the query, ignoring case; a blank query keeps every row. */
export function searchRows<T>(items: readonly T[], rowOf: (item: T) => GridValue[], query: string, columns: GridColumn[], valueFormat: ValueFormat | undefined, locale: string): T[] {
  const wanted = query.trim().toLocaleLowerCase(locale);
  if (wanted === '') return [...items];
  return items.filter((item) => rowOf(item).some((value, index) => index < columns.length && shownTextOf(value, columns[index], valueFormat, locale).toLocaleLowerCase(locale).includes(wanted)));
}

export const isLink = (value: GridValue): value is GridLink =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.text === 'string' && typeof value.href === 'string';

/** The value a grid cell sorts and reads by: a link by its text. */
export const plainOf = (value: GridValue): string | number | null => (isLink(value) ? value.text : typeof value === 'object' ? null : value);

// @cpt-algo:cpt-frontx-dashboard-algo-widget-catalog-grid-sort:p2
/**
 * The order of the delivered rows for one sort column and direction: numbers
 * first, then strings by the host language's collator, then nulls, which stay
 * last in both directions. Equal values keep their delivered order.
 */
export function sortRows<T>(items: readonly T[], valueOf: (item: T) => GridValue, direction: 'asc' | 'desc', locale: string): T[] {
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-grid-sort:p2:inst-wc-sort-groups
  const collator = new Intl.Collator(locale, { numeric: true });
  const rank = (value: string | number | null) => (typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2);
  const sign = direction === 'asc' ? 1 : -1;
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-grid-sort:p2:inst-wc-sort-groups
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-grid-sort:p2:inst-wc-sort-compare
  // Array.prototype.sort is stable, which keeps equal rows in their delivered order (inst-wc-sort-stable).
  return [...items].sort((left, right) => {
    const a = plainOf(valueOf(left));
    const b = plainOf(valueOf(right));
    const groups = rank(a) - rank(b);
    if (groups !== 0) return groups;
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
    if (typeof a === 'string' && typeof b === 'string') return collator.compare(a, b) * sign;
    return 0;
  });
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-grid-sort:p2:inst-wc-sort-compare
}

/** How many leading columns are pinned: `frozen_columns`, extended to the end of a group it cuts, since a kit group pins as a whole. */
export function pinnedCount(render: GridRender): number {
  let count = Math.min(render.frozen_columns ?? 0, render.columns.length);
  if (count === 0) return 0;
  for (const group of render.column_groups ?? []) {
    const positions = group.members.map((key) => render.columns.findIndex((column) => column.key === key));
    const first = Math.min(...positions);
    const last = Math.max(...positions);
    if (first < count && last >= count) count = last + 1;
  }
  return count;
}
