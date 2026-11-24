import { Area, Bar, CartesianGrid, ComposedChart, LabelList, Line, ReferenceLine, Scatter, ScatterChart, XAxis, YAxis, ZAxis, usePlotArea, useYAxisScale, type LabelProps } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatShare, formatValue, textOf, nonFiniteProblemOf } from '../format';
import { legendOf, PALETTE } from './legend';
import { dateFormatOf, timeOf as timeOfText } from '../time';
import { DEFAULT_WIDGET_TEXTS, ValuesText, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import type { CartesianData, CartesianRender, CartesianSeriesOption, ReferenceLineOption } from '../types';
import styles from '../widgets.module.css';
import { ChartShell } from './ChartShell';
import { FILL, pickIndexOf, TICK, TICK_CHAR_WIDTH, TICK_TEXT_HEIGHT } from './chrome';
import type { ValuesTable } from './DataView';
import { isCompact, isLaidOut, useElementSize } from './size';
import { cutTicks } from './ticks';

// A bar gets its value written above it from this width up, in `auto` mode.
const MIN_LABELLED_BAR = 28;
// The gap between two level x tick labels: `every` steps its labels this far apart, `auto` keeps them this far apart (Recharts' minTickGap).
const TICK_GAP = { every: 8, auto: 24 };
const PRIMARY_AXIS_WIDTH = 44;
const SECONDARY_AXIS_WIDTH = 44;
// A rotated tick stays on one line: Recharts wraps tick text to the slot width, which breaks a rotated label into overlapping lines.
const ROTATED_TICK = { ...TICK, width: 10_000 };
// The heights of a value label and of an end label line, at the micro text size, with the value label's offset.
const VALUE_LABEL_HEIGHT = 12;
const END_LABEL_HEIGHT = 12;
const VALUE_LABEL_OFFSET = 4;
// The room an axis title takes beside its ticks: one micro text line with a gap.
const AXIS_TITLE = 16;
const DAY = 86_400_000;
// A sized scatter point's radius runs between these, its area in proportion to its size above the floor; a compact chart halves the largest.
const BUBBLE_RADIUS = { min: 3, max: 18, compactMax: 9 };
// The axis of a category value: a horizontal chart's categories stand on this y axis.
const CATEGORY_AXIS = 'category';

/**
 * A place on a time axis in epoch milliseconds: a number as it is, and a string by the widgets' one time reader (an
 * ISO 8601 date-time, or a bare `YYYY-MM-DD` date as its UTC midnight by the heatmap calendar's rule). NaN for any other
 * string, a day the calendar does not have such as 2026-02-30 (alone or before a time of day), and a time a date
 * cannot hold (Date takes only ±8.64e15 milliseconds around 1970).
 */
const timeOf = (x: string | number) => (typeof x === 'number' ? new Date(x).getTime() : (timeOfText(x) ?? NaN));
/** A point's place on its x axis: on a time axis an ISO x becomes epoch milliseconds, so it keys and draws as a number. */
const placeOf = (x: string | number | null, axis: 'category' | 'value' | 'time') => (axis === 'time' && typeof x === 'string' ? timeOf(x) : x);
/** The key of an x place: its kind and text, so "1" and 1 stay apart. */
const placeKey = (x: string | number | null) => `${typeof x}:${String(x)}`;

/**
 * How a data series is drawn: its entry in `render.series`. A series without an entry draws as bars on the primary
 * axis, in `unlisted_stack_group` when the render sets it, so every view and check takes it as a member of that group.
 */
function seriesOptionOf(render: CartesianRender, name: string | null): CartesianSeriesOption | undefined {
  const option = render.series?.find((series) => series.name === name);
  if (option || render.unlisted_stack_group === undefined) return option;
  return { name: name ?? '', type: 'bar', stack_group: render.unlisted_stack_group };
}

// @cpt-algo:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2
/** The chart's own check of x values against the x axis type: the first problem found, or null. */
export function checkCartesian(render: CartesianRender, data: CartesianData): string | null {
  const axis = render.x_axis?.type ?? 'category';
  // The problem names the series and the point by position: series names are delivered data, which the console never gets.
  for (const [seriesIndex, series] of data.series.entries()) {
    for (const [index, point] of series.points.entries()) {
      if (point.x === null) continue;
      // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-value-x
      if (axis === 'value' && typeof point.x !== 'number') return `cartesian_chart: series ${seriesIndex} point ${index} needs a number x`;
      // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-value-x
      // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-time-x
      // A number must also be a time a date can hold.
      if (axis === 'time' && !Number.isFinite(timeOf(point.x))) {
        return `cartesian_chart: series ${seriesIndex} point ${index} needs an ISO 8601 date-time, a YYYY-MM-DD date or epoch milliseconds`;
      }
      // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-time-x
    }
  }
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-log-y
  for (const [seriesIndex, series] of data.series.entries()) {
    const secondary = render.series?.find((option) => option.name === series.name)?.y_axis === 'secondary';
    if ((secondary ? render.y_axis_secondary?.type : render.y_axis?.type) !== 'log') continue;
    // On a value or time axis a point with a null x is not drawn, so its y is not checked.
    const index = series.points.findIndex((point) => (axis === 'category' || point.x !== null) && point.y !== null && !(point.y > 0));
    if (index >= 0) return `cartesian_chart: series ${seriesIndex} point ${index} needs a y above zero on its log axis`;
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-log-y
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-orientation
  if (render.orientation === 'horizontal' && axis !== 'category') return `cartesian_chart: orientation horizontal needs a category x axis, and the x axis is ${axis}`;
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-orientation
  const optionOf = (name: string | null) => seriesOptionOf(render, name);
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-extremes
  for (const [index, option] of (render.series ?? []).entries())
    if (option.mark_extremes !== undefined && option.type !== 'line' && option.type !== 'area')
      // An option without a type draws as bars, and is named so.
      return `cartesian_chart: series option ${index} is a ${option.type ?? 'bar'}, and mark_extremes applies to a line or area`;
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-extremes
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-size
  for (const [seriesIndex, series] of data.series.entries()) {
    if ((optionOf(series.name)?.type ?? 'bar') === 'scatter') continue;
    const index = series.points.findIndex((point) => point.size !== undefined && point.size !== null);
    if (index >= 0) return `cartesian_chart: series ${seriesIndex} point ${index} has a size, and only a scatter series takes one`;
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-size
  const sideOf = (name: string | null) => (optionOf(name)?.y_axis === 'secondary' ? 'secondary' : 'primary');
  const stacked = (name: string | null) => optionOf(name)?.stack_group !== undefined && (optionOf(name)?.type ?? 'bar') !== 'scatter';
  // Under a percent stack an axis that carries a stack group shows shares.
  const percentSides = new Set(render.stack_mode === 'percent' ? data.series.filter((series) => stacked(series.name)).map((series) => sideOf(series.name)) : []);
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-percent
  if (render.stack_mode === 'percent') {
    // Every series drawn on a percent axis must be one of a group.
    for (const [seriesIndex, series] of data.series.entries()) {
      if (!percentSides.has(sideOf(series.name))) continue;
      if (!stacked(series.name)) return `cartesian_chart: series ${seriesIndex} is on a percent stacked axis without a stack group`;
      const index = series.points.findIndex((point) => point.y !== null && point.y < 0);
      if (index >= 0) return `cartesian_chart: series ${seriesIndex} point ${index} is negative, and a percent stack takes no negative value`;
    }
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-percent
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-reference
  const secondaryUsed = data.series.some((series) => optionOf(series.name)?.y_axis === 'secondary');
  for (const [index, line] of (render.reference_lines ?? []).entries()) {
    const on = line.axis ?? 'y';
    if (on === 'y_secondary' && !secondaryUsed) return `cartesian_chart: reference line ${index} is on y_secondary, and no series uses the secondary axis`;
    // On a time x axis a line takes what a point's x takes, within the same bound.
    if (on === 'x' && axis === 'time') {
      if (!Number.isFinite(timeOf(line.value))) return `cartesian_chart: reference line ${index} needs an ISO 8601 date-time, a YYYY-MM-DD date or epoch milliseconds on the time x axis`;
      continue;
    }
    if (typeof line.value === 'string' && (on !== 'x' || axis !== 'category')) return `cartesian_chart: reference line ${index} has a category value, and its axis is not a category x axis`;
    if (typeof line.value === 'number' && on === 'x' && axis === 'category') return `cartesian_chart: reference line ${index} has a number value on a category x axis, which takes a category`;
    if (on === 'x' || typeof line.value !== 'number') continue;
    // A value axis line follows the rules of the points on that axis: a share on a percent axis, above zero on a log one.
    const side = on === 'y_secondary' ? 'secondary' : 'primary';
    if (percentSides.has(side)) {
      if (line.value < 0 || line.value > 1) return `cartesian_chart: reference line ${index} is off its axis: on a percent axis a value is a share from 0 to 1`;
    } else if ((side === 'secondary' ? render.y_axis_secondary?.type : render.y_axis?.type) === 'log' && !(line.value > 0)) {
      return `cartesian_chart: reference line ${index} needs a value above zero on its log axis`;
    }
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-cartesian-checks:p2:inst-wc-cart-reference
  return null;
}

/**
 * A bar value label at the end label's row: the y axis it is drawn on, the value at the bar's end, and whether
 * Recharts writes it below that end, which it does for a bar or stack segment that grows downwards.
 */
export interface LabelledTop {
  axis: 'primary' | 'secondary';
  value: number;
  below: boolean;
}

// The name of a series at its end, drawn on its last point so it follows a target that changes over the period.
// It moves up above any value label it would cover there. One component type for every render; LabelList clones the element with the point's props.
function EndLabel(props: LabelProps & { text?: string; last?: number; tops?: LabelledTop[]; horizontal?: boolean }) {
  const scales = { primary: useYAxisScale('primary'), secondary: useYAxisScale('secondary') };
  if (props.index !== props.last) return null;
  // A horizontal chart ends a series at its lowest category: the name stands to the right of that point.
  if (props.horizontal)
    return (
      <text x={Number(props.x) + 8} y={Number(props.y) + 4} textAnchor="start" className={styles.lineLabel}>
        {props.text}
      </text>
    );
  // Value label boxes as [top, bottom] pixel ranges, lowest on screen first, so each lift is checked against every box above it.
  const boxes = (props.tops ?? [])
    .map(({ axis, value, below }) => ({ y: scales[axis]?.(value), below }))
    .filter((box): box is { y: number; below: boolean } => typeof box.y === 'number' && Number.isFinite(box.y))
    .map(({ y, below }): readonly [number, number] => (below ? [y + VALUE_LABEL_OFFSET, y + VALUE_LABEL_OFFSET + VALUE_LABEL_HEIGHT] : [y - VALUE_LABEL_OFFSET - VALUE_LABEL_HEIGHT, y - VALUE_LABEL_OFFSET]))
    .sort((a, b) => b[0] - a[0]);
  let baseline = Number(props.y) - 8;
  for (const [top, bottom] of boxes) if (baseline > top && baseline - END_LABEL_HEIGHT < bottom) baseline = top - 2;
  return (
    <text x={Number(props.x)} y={baseline} textAnchor="end" className={styles.lineLabel}>
      {props.text}
    </text>
  );
}

/** The rows of a series' lowest and highest delivered values, on ties the first in axis order (the drawn order); a kind not asked for is absent. */
export interface ExtremeRows {
  min?: number;
  max?: number;
}

// About the width of one micro text character, for the room an extreme or reference label takes.
const LABEL_CHAR_WIDTH = 6;

/**
 * The mark of a series' lowest or highest point: a dot in the series colour with the value beside it, above a
 * highest point and below a lowest one (right and left of them on a horizontal chart). A label that would leave
 * the plot moves to the point's other side. One component type for every render; LabelList clones it per point.
 */
function ExtremeMark(props: LabelProps & { marks?: ExtremeRows; text?: (row: number) => string; color?: string; horizontal?: boolean; labelled?: boolean }) {
  const plot = usePlotArea();
  const row = Number(props.index);
  const kind = row === props.marks?.max ? 'max' : row === props.marks?.min ? 'min' : null;
  const x = Number(props.x);
  const y = Number(props.y);
  if (kind === null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const text = props.text?.(row) ?? '';
  let label = null;
  if (props.labelled !== false) {
    if (props.horizontal) {
      const width = text.length * LABEL_CHAR_WIDTH;
      const right = plot ? plot.x + plot.width : Infinity;
      const left = plot ? plot.x : -Infinity;
      const after = kind === 'max' ? x + 7 + width <= right : !(x - 7 - width >= left);
      label = (
        <text x={after ? x + 7 : x - 7} y={y + 4} textAnchor={after ? 'start' : 'end'} className={styles.extremeLabel} data-extreme={kind}>
          {text}
        </text>
      );
    } else {
      const top = plot ? plot.y : -Infinity;
      const bottom = plot ? plot.y + plot.height : Infinity;
      // Above: the text's baseline 6px over the point, its top about 12px higher. Below: its top 6px under the point.
      const above = kind === 'max' ? y - 6 - VALUE_LABEL_HEIGHT >= top : y + 6 + VALUE_LABEL_HEIGHT > bottom;
      label = (
        <text x={x} y={above ? y - 6 : y + 6 + 10} textAnchor="middle" className={styles.extremeLabel} data-extreme={kind}>
          {text}
        </text>
      );
    }
  }
  return (
    <g data-extreme-mark={kind}>
      <circle cx={x} cy={y} r={3.5} fill={props.color} stroke="var(--background)" strokeWidth={1.5} />
      {label}
    </g>
  );
}

/**
 * The reference lines of a render, each across the plot at its value, in the muted tone of the axes. A line
 * outside the data extends its axis to hold it. Its label stands at its end: the right end of a line across,
 * the top of an upright one.
 */
function referenceLinesOf(lines: ReferenceLineOption[] | undefined, horizontal: boolean, xAxis: 'category' | 'value' | 'time') {
  return (lines ?? []).map((line, index) => {
    const on = line.axis ?? 'y';
    // On a time x axis an ISO date-time stands at its epoch milliseconds, where a point with that x is drawn.
    const value = on === 'x' && xAxis === 'time' ? timeOf(line.value) : line.value;
    const valueAxis = on === 'y_secondary' ? 'secondary' : 'primary';
    const at = horizontal
      ? on === 'x'
        ? { y: value, yAxisId: CATEGORY_AXIS, xAxisId: 'primary' }
        : { x: value, xAxisId: valueAxis, yAxisId: CATEGORY_AXIS }
      : on === 'x'
        ? { x: value, yAxisId: 'primary' }
        : { y: value, yAxisId: valueAxis };
    const across = 'y' in at;
    return (
      <ReferenceLine
        key={`reference-${index}`}
        {...at}
        ifOverflow="extendDomain"
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
        strokeDasharray={(line.line_style ?? 'dashed') === 'dashed' ? '4 4' : undefined}
        className={styles.referenceLine}
        label={line.label ? { value: line.label, position: across ? 'insideBottomRight' : 'insideTopLeft', fill: 'var(--muted-foreground)', className: styles.referenceLabel } : undefined}
      />
    );
  });
}

/** The radii of sized scatter points as Recharts symbol areas: a point's area is its share of the largest size, above the floor. */
function bubbleAreaOf(maxSize: number, compact: boolean) {
  const largest = Math.PI * (compact ? BUBBLE_RADIUS.compactMax : BUBBLE_RADIUS.max) ** 2;
  const smallest = Math.PI * BUBBLE_RADIUS.min ** 2;
  return { largest, area: (size: number | null | undefined) => (typeof size === 'number' && maxSize > 0 ? Math.max(smallest, (size / maxSize) * largest) : smallest) };
}

type Row = Record<string, string | number | null>;

// One row per x position: in delivered order on a category axis, by value on a value or time axis,
// where a point with a null x has no position and is left out. The key keeps "1" and 1 apart, and a
// series that repeats an x gets one row per repeat, so no delivered point is overwritten. `v<i>` holds
// a series' delivered value, `s<i>` the value it is drawn at (see `drawnValues`).
function rowsOf(data: CartesianData, axis: 'category' | 'value' | 'time'): Row[] {
  const rows = new Map<string, Row>();
  data.series.forEach((series, index) => {
    const repeats = new Map<string, number>();
    for (const point of series.points) {
      if (axis !== 'category' && point.x === null) continue;
      const x = placeOf(point.x, axis);
      const value = placeKey(x);
      const repeat = repeats.get(value) ?? 0;
      repeats.set(value, repeat + 1);
      const key = `${value}#${repeat}`;
      const row = rows.get(key) ?? { x };
      row[`v${index}`] = point.y;
      row[`s${index}`] = point.y;
      rows.set(key, row);
    }
  });
  const list = [...rows.values()];
  return axis === 'category' ? list : list.sort((a, b) => Number(a.x ?? 0) - Number(b.x ?? 0));
}

/**
 * Sets the drawn values of the line and area series in sorted rows. On a value or time axis a row exists for
 * every x of every series, so a line or area that has no point at another series' x would break there:
 * it gets the value on the straight line between its own points around that x (straight on the axis's
 * scale: on a log axis, between the logarithms), which is drawn and never shown as a value. A null value
 * stays a gap. Line series of a stack group then draw the running total of the group's lines on their axis,
 * in delivered order; bars and areas stack among themselves in Recharts.
 */
function drawnValues(
  rows: Row[],
  data: CartesianData,
  axis: 'category' | 'value' | 'time',
  optionOf: (name: string | null) => CartesianSeriesOption | undefined,
  logAxis: (index: number) => boolean,
  percent = false,
) {
  const typeOf = (index: number) => optionOf(data.series[index].name)?.type ?? 'bar';
  if (axis !== 'category') {
    data.series.forEach((_, index) => {
      if (typeOf(index) !== 'line' && typeOf(index) !== 'area') return;
      const key = `v${index}`;
      let previous = -1;
      rows.forEach((row, at) => {
        if (!(key in row)) return;
        const from = rows[previous]?.[key];
        const to = row[key];
        if (previous >= 0 && typeof from === 'number' && typeof to === 'number') {
          // Halves of the x values, so two x values as far apart as 1.5e308 and -1.5e308 give a finite span.
          const x0 = Number(rows[previous].x) / 2;
          const halfSpan = Number(row.x) / 2 - x0;
          const log = logAxis(index) && from > 0 && to > 0;
          for (let between = previous + 1; between < at; between += 1) {
            const share = halfSpan === 0 ? 0 : (Number(rows[between].x) / 2 - x0) / halfSpan;
            // Between the logarithms, which stays finite for any two positive values; otherwise a weighted mean of the two
            // values, which stays between them where `to - from` would overflow.
            rows[between][`s${index}`] = log ? Math.exp((1 - share) * Math.log(from) + share * Math.log(to)) : from * (1 - share) + to * share;
          }
        }
        previous = at;
      });
    });
  }
  // A percent stack draws each member of a group at its share of the group's sum at that x, kept as `p<i>` for the
  // tooltip; bars and areas share a group, lines have their own, as they stack. A sum of 0 draws every member at 0. A
  // finite sum gives the exact share; only a sum beyond the largest number (two 1e308 values) is taken over the members
  // divided by the largest, so each still draws at half.
  if (percent) {
    const groups = new Map<string, number[]>();
    data.series.forEach((series, index) => {
      const option = optionOf(series.name);
      const type = typeOf(index);
      if (option?.stack_group === undefined || type === 'scatter') return;
      const group = `${option.y_axis === 'secondary' ? 'secondary' : 'primary'}:${option.stack_group}:${type === 'line' ? 'line' : 'fill'}`;
      groups.set(group, [...(groups.get(group) ?? []), index]);
    });
    for (const row of rows)
      for (const members of groups.values()) {
        const numberAt = (index: number) => (typeof row[`s${index}`] === 'number' ? (row[`s${index}`] as number) : 0);
        const plain = members.reduce((total, index) => total + numberAt(index), 0);
        // The scale the members are divided by before summing: 1 for a finite sum, the largest member otherwise.
        const scale = Number.isFinite(plain) ? 1 : members.reduce((most, index) => Math.max(most, numberAt(index)), 0);
        const sum = Number.isFinite(plain) ? plain : members.reduce((total, index) => total + numberAt(index) / scale, 0);
        for (const index of members) {
          const value = row[`s${index}`];
          if (typeof value !== 'number') continue;
          row[`s${index}`] = sum > 0 ? value / scale / sum : 0;
          row[`p${index}`] = row[`s${index}`];
        }
      }
  }
  const totals = new Map<string, number[]>();
  data.series.forEach((series, index) => {
    const option = optionOf(series.name);
    if (typeOf(index) !== 'line' || option?.stack_group === undefined) return;
    const group = `${option.y_axis === 'secondary' ? 'secondary' : 'primary'}:${option.stack_group}`;
    const sums = totals.get(group) ?? rows.map(() => 0);
    totals.set(group, sums);
    rows.forEach((row, at) => {
      const value = row[`s${index}`];
      if (typeof value !== 'number') return;
      sums[at] += value;
      // A running total beyond the largest number is not drawn: the line has a gap there.
      row[`s${index}`] = Number.isFinite(sums[at]) ? sums[at] : null;
    });
  });
}

// @cpt-dod:cpt-frontx-dashboard-dod-widget-catalog-rendering:p2
/** The `cartesian_chart` widget: the kit chart with Recharts series on one or two y axes. */
export function CartesianChart({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
  label: labelProp,
  container,
}: {
  payload: RenderWidgetPayload<CartesianRender, CartesianData>;
  locale?: string;
  texts?: WidgetTexts;
  /** The chart's accessible name; `texts.chart` when the cell gives none. */
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  const label = labelProp ?? texts.chart;
  const [measure, { width, height }] = useElementSize();
  const laidOut = isLaidOut({ width, height });
  const compact = isCompact(height);
  if (!data) return <WidgetCannotBeShown texts={texts} problem="cartesian_chart: no data" />;
  const nonFinite = nonFiniteProblemOf('cartesian_chart', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  const problem = checkCartesian(render, data);
  if (problem) return <WidgetCannotBeShown texts={texts} problem={problem} />;
  if (data.series.length === 0 || data.series.every((series) => series.points.length === 0)) return <WidgetEmpty texts={texts} />;

  const axis = render.x_axis?.type ?? 'category';
  const optionOf = (name: string | null) => seriesOptionOf(render, name);
  const typeOf = (name: string | null) => optionOf(name)?.type ?? 'bar';
  const config: ChartConfig = Object.fromEntries(data.series.map((series, index) => [`s${index}`, { label: series.name ?? '', color: PALETTE[index % PALETTE.length] }]));
  const format = (value: string | number | null) => (typeof value === 'number' ? formatValue(value, value_format, locale) : (value ?? ''));
  const unit = render.y_axis_secondary?.unit ?? '';
  // A series on the secondary axis shows plain numbers with that axis's unit; the others follow value_format.
  const onSecondary = (index: number) => optionOf(data.series[index]?.name ?? null)?.y_axis === 'secondary';
  const formatSeries = (index: number) => (value: string | number | null) =>
    onSecondary(index) && typeof value === 'number' ? `${formatValue(value, undefined, locale)}${unit}` : format(value);
  // The tooltip names a series by its legend label and shows its value as the chart formats it.
  // A scatter entry is named by its axis: x by the x label, y by its series, which each point carries.
  const labelOf = (name: string, key: unknown, item: unknown) => {
    if (name === 'x') return xLabel;
    if (name === 'z') return sizeLabel;
    const series = (item as { payload?: { series?: unknown } } | undefined)?.payload?.series;
    if (name === 'y' && typeof series === 'number') return String(config[`s${series}`]?.label ?? '');
    return String(config[name]?.label ?? key);
  };
  const tooltipFormatter = (valueOf: (key: string, value: number, item: unknown) => string) =>
    function TooltipValue(value: unknown, key: unknown, item: unknown) {
      // A scatter entry names its axis by its dataKey ("x" or "y"); a series entry by its config key.
      const dataKey = (item as { dataKey?: unknown } | undefined)?.dataKey;
      const name = dataKey === 'x' || dataKey === 'y' || dataKey === 'z' ? String(dataKey) : String(key);
      return (
        <span className={styles.tooltipRow}>
          <span>{labelOf(name, key, item)}</span>
          <span className={styles.tooltipValue}>{typeof value === 'number' ? valueOf(name, value, item) : String(value ?? '')}</span>
        </span>
      );
    };
  // On a time axis, points that all fall on a midnight are days: every view shows the date alone, read in UTC when they
  // are UTC midnights, so a day delivered as 00:00Z keeps its date in any zone. Otherwise the ticks show the time of day
  // when the points span less than two days (with the day when they cross a local midnight) and dates beyond that,
  // and every other view shows the date with the time.
  const times = axis === 'time' ? data.series.flatMap((series) => series.points.map((point) => (typeof point.x === 'string' ? timeOf(point.x) : point.x))).filter((x): x is number => typeof x === 'number') : [];
  const first = times.reduce((min, time) => Math.min(min, time), Infinity);
  const last = times.reduce((max, time) => Math.max(max, time), -Infinity);
  const utcDays = times.every((time) => time % DAY === 0);
  const days = utcDays || times.every((time) => new Date(time).setHours(0, 0, 0, 0) === time);
  const timeStyle = times.some((time) => time % 60_000 !== 0) ? 'medium' : 'short';
  const oneDay = times.length > 0 && new Date(first).toDateString() === new Date(last).toDateString();
  const dayFormat: Intl.DateTimeFormatOptions = { dateStyle: 'medium', ...(utcDays ? { timeZone: 'UTC' } : {}) };
  const hours: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', ...(timeStyle === 'medium' ? { second: '2-digit' } : {}) };
  // A date before the year 1 writes its era, so the year 0 (1 BC) does not read as the year 1.
  const tickDates = dateFormatOf(locale, days || last - first >= 2 * DAY ? dayFormat : oneDay ? { timeStyle } : { month: 'short', day: 'numeric', ...hours });
  const fullDates = dateFormatOf(locale, days ? dayFormat : { dateStyle: 'medium', timeStyle });
  const xText = (value: string | number | null) => (axis === 'time' && typeof value === 'number' ? fullDates(value) : textOf(value, undefined, locale));
  const tickText = (value: string | number | null) => (axis === 'time' && typeof value === 'number' ? tickDates(value) : textOf(value, undefined, locale));
  const xLabel = render.x_axis?.label ?? texts.columns.x;
  const sizeLabel = render.size_label ?? texts.columns.size;
  // Sized scatter points: the largest delivered size sets the largest bubble, so sizes of all series compare.
  const sizes = data.series.flatMap((series) => series.points.flatMap((point) => (typeof point.size === 'number' ? [point.size] : [])));
  const sized = sizes.length > 0;
  const bubbles = bubbleAreaOf(sizes.reduce((max, size) => Math.max(max, size), 0), compact);
  const formatSize = (value: string | number | null) => (typeof value === 'number' ? formatValue(value, undefined, locale) : (value ?? ''));
  // Axis titles: the x title under the ticks, a y title along its axis, outside the ticks; each axis grows by the title's line.
  // The offsets keep the whole line inside the chart: the descenders of an x title, half the line height of a turned y title.
  const titleOf = (value: string | undefined, side: 'x' | 'xTop' | 'primary' | 'secondary') =>
    value
      ? {
          value,
          fill: TICK.fill,
          className: styles.axisTitle,
          ...(side === 'x' || side === 'xTop'
            ? { position: side === 'x' ? ('insideBottom' as const) : ('insideTop' as const), offset: 3 }
            : { angle: side === 'primary' ? -90 : 90, position: side === 'primary' ? ('insideLeft' as const) : ('insideRight' as const), offset: 8, style: { textAnchor: 'middle' as const } }),
        }
      : undefined;
  const primaryWidth = PRIMARY_AXIS_WIDTH + (render.y_axis?.label ? AXIS_TITLE : 0);
  const secondaryWidth = SECONDARY_AXIS_WIDTH + (render.y_axis_secondary?.label ? AXIS_TITLE : 0);
  const xTitle = render.x_axis?.label ? AXIS_TITLE : 0;
  // tick_angle turns the x ticks under the plot; a horizontal chart writes its categories level beside it.
  const angle = compact || render.orientation === 'horizontal' ? 0 : (render.x_axis?.tick_angle ?? 0);
  const legend = compact && data.series.length <= 1 ? 'none' : render.legend_position;
  const sine = Math.sin((Math.abs(angle) * Math.PI) / 180);
  // The x axis height for tick labels of up to `longest` characters at the tick angle, with the x title.
  const xAxisHeight = (longest: number) => (angle === 0 ? 30 : Math.ceil(longest * TICK_CHAR_WIDTH * sine) + 16) + xTitle;
  // A rotated label runs left of its tick: the first one's label can pass the y axis, so the chart keeps that room and the plot is narrower by it.
  const overhangOf = (firstLabel: number) => (angle === 0 ? 0 : Math.max(0, Math.ceil(firstLabel * TICK_CHAR_WIDTH * Math.cos((Math.abs(angle) * Math.PI) / 180)) - primaryWidth));
  const xTick = { angle, tick: angle === 0 ? TICK : ROTATED_TICK, textAnchor: angle === 0 ? ('middle' as const) : ('end' as const) };

  // Scatter series on a value or time x axis carry their own x and y per point, so the chart draws each series on two value axes.
  // On a category axis they draw as points over the categories of the composed chart below.
  if (axis !== 'category' && data.series.every((series) => typeOf(series.name) === 'scatter')) {
    // On a time axis an ISO x becomes epoch milliseconds, so every view of it shows the same localized date.
    const xOf = (x: string | number | null) => placeOf(x, axis);
    const table: ValuesTable = {
      columns: [texts.columns.series, xLabel, render.y_axis?.label ?? texts.columns.y, ...(sized ? [sizeLabel] : [])],
      rows: data.series.flatMap((series) => series.points.map((point) => [series.name, xOf(point.x), point.y, ...(sized ? [point.size ?? null] : [])])),
    };
    // The series of each table row, so a y value is formatted by its own series' axis.
    const seriesOfRow = data.series.flatMap((series, index) => series.points.map(() => index));
    const formatCell = (row: number, column: number, value: string | number | null) =>
      column === 1 ? xText(value) : column === 2 ? formatSeries(seriesOfRow[row])(value) : column === 3 ? formatSize(value) : format(value);
    const scatterSecondary = data.series.some((_, index) => onSecondary(index));
    const offsets = data.series.map((_, index) => data.series.slice(0, index).reduce((sum, series) => sum + series.points.length, 0));
    // The first x tick sits at the smallest x.
    const xs = table.rows.map((row) => row[1]).filter((x): x is number => typeof x === 'number');
    // A reduce, not Math.min(...xs): spreading a very long series overflows the call stack.
    // A bubble at the edge of the data keeps its whole disc inside the plot: the axes leave the largest radius free at their ends.
    const edge = sized ? Math.ceil(Math.sqrt(bubbles.largest / Math.PI)) + 1 : 0;
    const bubblePadding = { x: { left: edge, right: edge }, y: { top: edge, bottom: edge } };
    const firstOverhang = xs.length > 0 ? overhangOf(tickText(xs.reduce((min, x) => Math.min(min, x), Infinity)).length) : 0;
    return (
      <div ref={measure} className={styles.fill} role="figure" aria-label={label}>
        <ChartShell
          drillDown={render.drill_down === true}
          laidOut={laidOut}
          table={table}
          label={texts.dataOf(label)}
          texts={texts}
          format={(value, column, row) => formatCell(row, column, value)}
          locale={locale}
          container={container}
          draw={(onPick) => (
            <ChartContainer config={config} style={FILL}>
              <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: firstOverhang }}>
                <CartesianGrid />
                <XAxis type="number" dataKey="x" name={xLabel} domain={['dataMin', 'dataMax']} padding={bubblePadding.x} tickLine={false} axisLine={false} tickFormatter={(value: number) => tickText(value)} height={xAxisHeight(table.rows.reduce((max, row) => Math.max(max, tickText(row[1]).length), 0))} label={titleOf(render.x_axis?.label, 'x')} {...xTick} />
                <YAxis
                  yAxisId="primary"
                  tick={TICK}
                  type="number"
                  dataKey="y"
                  name={render.y_axis?.label}
                  tickLine={false}
                  axisLine={false}
                  width={primaryWidth}
                  label={titleOf(render.y_axis?.label, 'primary')}
                  scale={render.y_axis?.type === 'log' ? 'log' : 'auto'}
                  domain={['auto', 'auto']}
                  padding={bubblePadding.y}
                  tickFormatter={(value: number) => formatValue(value, value_format, locale, 'compact')}
                />
                {scatterSecondary ? (
                  <YAxis
                    yAxisId="secondary"
                    tick={TICK}
                    orientation="right"
                    type="number"
                    dataKey="y"
                    name={render.y_axis_secondary?.label}
                    tickLine={false}
                    axisLine={false}
                    width={secondaryWidth}
                    label={titleOf(render.y_axis_secondary?.label, 'secondary')}
                    scale={render.y_axis_secondary?.type === 'log' ? 'log' : 'auto'}
                    domain={['auto', 'auto']}
                    padding={bubblePadding.y}
                    tickFormatter={(value: number) => `${formatValue(value, undefined, locale, 'compact')}${unit}`}
                  />
                ) : null}
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      hideLabel
                      formatter={tooltipFormatter((key, value, item) => {
                        if (key === 'x') return xText(value);
                        // The size shows as delivered: the drawn value is the bubble's area.
                        if (key === 'z') return formatSize(((item as { payload?: { size?: number | null } } | undefined)?.payload?.size ?? null) as number | null);
                        const series = Number((item as { payload?: { series?: unknown } } | undefined)?.payload?.series);
                        return Number.isInteger(series) ? formatSeries(series)(value) : format(value);
                      })}
                    />
                  }
                />
                {legendOf(legend)}
                {sized ? <ZAxis zAxisId="size" type="number" dataKey="z" name={sizeLabel} domain={[0, bubbles.largest]} range={[0, bubbles.largest]} /> : null}
                {referenceLinesOf(render.reference_lines, false, axis)}
                {data.series.map((series, index) => (
                  <Scatter
                    key={index}
                    name={`s${index}`}
                    yAxisId={onSecondary(index) ? 'secondary' : 'primary'}
                    zAxisId={sized ? 'size' : undefined}
                    // A point with a null x has no position and is left out; each drawn point keeps its row of the values table for the pick.
                    data={series.points.flatMap((point, at) =>
                      point.x === null ? [] : [{ x: xOf(point.x), y: point.y, series: index, row: offsets[index] + at, ...(sized ? { z: bubbles.area(point.size), size: point.size ?? null } : {}) }],
                    )}
                    fill={`var(--color-s${index})`}
                    isAnimationActive={false}
                    onClick={
                      onPick
                        ? (entry: { payload?: { row?: unknown } }) => {
                            const row = Number(entry?.payload?.row);
                            if (Number.isInteger(row)) onPick(row);
                          }
                        : undefined
                    }
                  />
                ))}
              </ScatterChart>
            </ChartContainer>
          )}
        />
        <ValuesText caption={label} columns={table.columns} rows={table.rows.map((row, rowIndex) => row.map((value, index) => formatCell(rowIndex, index, value)))} />
      </div>
    );
  }

  const rows = rowsOf(data, axis);
  const horizontal = render.orientation === 'horizontal';
  const percent = render.stack_mode === 'percent';
  drawnValues(rows, data, axis, optionOf, (index) => (onSecondary(index) ? render.y_axis_secondary?.type : render.y_axis?.type) === 'log', percent);
  // The sizes of the scatter series that carry them, on the row of their x, for the bubbles, the tooltip and the data view.
  const sizedSeries = data.series.flatMap((series, index) => (typeOf(series.name) === 'scatter' && series.points.some((point) => typeof point.size === 'number') ? [index] : []));
  // The rows of each x place, in order: a series' n-th point at a place has the n-th of them, as rowsOf keyed it.
  const rowsAt = new Map<string, Row[]>();
  if (sizedSeries.length > 0)
    for (const row of rows) {
      const key = placeKey(row.x ?? null);
      const list = rowsAt.get(key);
      if (list) list.push(row);
      else rowsAt.set(key, [row]);
    }
  for (const index of sizedSeries) {
    const repeats = new Map<string, number>();
    for (const point of data.series[index].points) {
      // A point with a null x has no row on a value or time axis.
      if (axis !== 'category' && point.x === null) continue;
      const value = placeKey(placeOf(point.x, axis));
      const repeat = repeats.get(value) ?? 0;
      repeats.set(value, repeat + 1);
      const row = rowsAt.get(value)?.[repeat];
      if (!row) continue;
      row[`size${index}`] = point.size ?? null;
      row[`z${index}`] = bubbles.area(point.size);
    }
  }
  const table: ValuesTable = {
    columns: [xLabel, ...data.series.map((series) => series.name ?? ''), ...sizedSeries.map((index) => `${data.series[index].name ?? ''}: ${sizeLabel}`)],
    rows: rows.map((row) => [row.x ?? null, ...data.series.map((_, index) => row[`v${index}`] ?? null), ...sizedSeries.map((index) => row[`size${index}`] ?? null)]),
  };
  const formatColumn = (column: number) => (value: string | number | null) => (column === 0 ? xText(value) : column <= data.series.length ? formatSeries(column - 1)(value) : formatSize(value));
  const secondary = data.series.some((_, index) => onSecondary(index));
  // An axis that carries a stack group shows shares under a percent stack (the check keeps every series there in a group).
  const percentAxis = (side: 'primary' | 'secondary') =>
    percent && data.series.some((series, index) => optionOf(series.name)?.stack_group !== undefined && typeOf(series.name) !== 'scatter' && (onSecondary(index) ? 'secondary' : 'primary') === side);
  const share = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });

  // Value labels: `auto` writes them when each bar is wide enough. Bars of one stack share a slot; Recharts gives the slots 80% of a category.
  const barSlots = new Set(data.series.map((series, index) => (typeOf(series.name) === 'bar' ? (optionOf(series.name)?.stack_group ?? `s${index}`) : null)).filter(Boolean)).size;
  // A rotated label runs left of its tick: the first category's label can pass the y axis, so the chart keeps that room and the plot is narrower by it.
  const firstLabel = rows.length > 0 ? tickText(rows[0].x ?? null).length : 0;
  const rotatedOverhang = horizontal ? 0 : overhangOf(firstLabel);
  const longest = rows.reduce((max, row) => Math.max(max, tickText(row.x ?? null).length), 0);
  // A horizontal chart writes its categories beside the plot: the axis takes their width, up to a third of the chart.
  const categoryColumn = Math.max(48, Math.round(width / 3));
  const categoryWidth = Math.min(Math.ceil(longest * TICK_CHAR_WIDTH) + 12, categoryColumn) + (render.x_axis?.label ? AXIS_TITLE : 0);
  // A value axis along a horizontal chart is as tall as its ticks, and its own title when it has one.
  const valueAxisHeight = (side: 'primary' | 'secondary') => 30 + ((side === 'primary' ? render.y_axis : render.y_axis_secondary)?.label ? AXIS_TITLE : 0);
  const plotWidth = horizontal ? width - categoryWidth - 8 : width - primaryWidth - (secondary ? secondaryWidth : 8) - rotatedOverhang;
  // A horizontal bar's thickness: its share of the plot's height.
  const plotHeight = height - valueAxisHeight('primary') - (secondary ? valueAxisHeight('secondary') : 0) - 8;
  const barWidth = barSlots > 0 && rows.length > 0 ? ((horizontal ? plotHeight : plotWidth) * 0.8) / rows.length / barSlots : 0;
  const labels = render.value_labels ?? 'never';
  // A horizontal bar needs the height of its value's line, a vertical one the width of a value.
  const showValues = barSlots > 0 && (labels === 'always' || (labels === 'auto' && barWidth >= (horizontal ? VALUE_LABEL_HEIGHT + 2 : MIN_LABELLED_BAR)));

  // Tick labels: `every` labels each category and thins out to every 2nd, 3rd... when a category is narrower than a label needs.
  // Only a category axis has a tick per row; a value or time axis draws its own few number ticks, which minTickGap keeps apart.
  const every = axis === 'category' && render.x_axis?.tick_labels === 'every';
  const slot = rows.length > 0 ? (horizontal ? plotHeight : plotWidth) / rows.length : 0;
  // A category label longer than its room is cut with an ellipsis: a horizontal chart's room is its category column, a
  // level label's its band less the gap between labels. A turned label runs across its band and stays whole.
  const tickRoom = horizontal ? categoryColumn - 12 : angle === 0 && slot > 0 ? slot - TICK_GAP[every ? 'every' : 'auto'] : Infinity;
  const categoryTick = cutTicks(axis === 'category' ? rows.map((row) => tickText(row.x ?? null)) : [], tickRoom / TICK_CHAR_WIDTH);
  const axisTick = (value: string | number | null) => categoryTick(tickText(value));
  const longestTick = rows.reduce((max, row) => Math.max(max, axisTick(row.x ?? null).length), 0);
  const needed = horizontal ? TICK_TEXT_HEIGHT : angle === 0 ? longestTick * TICK_CHAR_WIDTH + TICK_GAP.every : TICK_TEXT_HEIGHT / sine;
  const tickStep = slot > 0 ? Math.max(1, Math.ceil(needed / slot)) : 1;
  // The row of a series' last drawn point, where its name goes; not the last row, which may hold only other series.
  const lastDrawn = (index: number) => rows.reduce((last, row, at) => (typeof row[`v${index}`] === 'number' ? at : last), -1);
  const hasEndLabel = data.series.some((series) => optionOf(series.name)?.label);
  // The rows of each line or area series' extreme marks: the lowest and the highest delivered value, the first in axis order on ties; nulls are skipped.
  const extremesOf = (index: number): ExtremeRows => {
    const asked = optionOf(data.series[index].name)?.mark_extremes;
    if (asked === undefined) return {};
    let min = -1;
    let max = -1;
    rows.forEach((row, at) => {
      const value = row[`v${index}`];
      if (typeof value !== 'number') return;
      if (min < 0 || value < (rows[min][`v${index}`] as number)) min = at;
      if (max < 0 || value > (rows[max][`v${index}`] as number)) max = at;
    });
    if (min < 0) return {};
    return { ...(asked !== 'max' ? { min } : {}), ...(asked !== 'min' ? { max } : {}) };
  };
  const hasMaxMark = data.series.some((_, index) => extremesOf(index).max !== undefined);
  // The tops of the value labels at a row, where an end label there must not be drawn: a stacked bar's label sits at its stack's running total.
  // The drawn value counts: under a percent stack, a bar stands at its share.
  const labelledTops = (rowIndex: number): LabelledTop[] => {
    if (!showValues) return [];
    const row = rows[rowIndex];
    const totals = new Map<string, number>();
    return data.series.flatMap((series, index) => {
      const value = row?.[`s${index}`];
      // A zero-height bar has no value label.
      if (typeOf(series.name) !== 'bar' || typeof value !== 'number' || value === 0) return [];
      const option = optionOf(series.name);
      const axis = option?.y_axis === 'secondary' ? 'secondary' : 'primary';
      const stack = option?.stack_group === undefined ? undefined : `${axis}:${option.stack_group}`;
      const top = stack === undefined ? value : (totals.get(stack) ?? 0) + value;
      if (stack !== undefined) totals.set(stack, top);
      return [{ axis, value: top, below: value < 0 } as LabelledTop];
    });
  };
  // A series' own extreme label at its last point is a box its end label keeps clear of too.
  const extremeTops = (index: number, rowIndex: number): LabelledTop[] => {
    const marks = extremesOf(index);
    const value = rows[rowIndex]?.[`s${index}`];
    if (typeof value !== 'number' || (marks.max !== rowIndex && marks.min !== rowIndex)) return [];
    return [{ axis: onSecondary(index) ? 'secondary' : 'primary', value, below: marks.max !== rowIndex }];
  };

  // The value axes: upright on a vertical chart, along the bottom (and the top for the secondary one) on a horizontal chart.
  const valueAxis = (side: 'primary' | 'secondary') => {
    const options = side === 'primary' ? render.y_axis : render.y_axis_secondary;
    const log = !percentAxis(side) && options?.type === 'log';
    const common = {
      tick: TICK,
      tickLine: false,
      axisLine: false,
      scale: log ? ('log' as const) : ('auto' as const),
      domain: percentAxis(side) ? [0, 1] : log ? ['auto', 'auto'] : undefined,
      tickFormatter: (value: number) =>
        percentAxis(side) ? formatShare(share, value) : side === 'primary' ? formatValue(value, value_format, locale, 'compact') : `${formatValue(value, undefined, locale, 'compact')}${unit}`,
    };
    if (horizontal)
      return (
        <XAxis
          key={side}
          xAxisId={side}
          type="number"
          orientation={side === 'primary' ? 'bottom' : 'top'}
          height={valueAxisHeight(side)}
          label={titleOf(options?.label, side === 'primary' ? 'x' : 'xTop')}
          minTickGap={24}
          {...common}
        />
      );
    return (
      <YAxis
        key={side}
        yAxisId={side}
        orientation={side === 'primary' ? 'left' : 'right'}
        width={side === 'primary' ? primaryWidth : secondaryWidth}
        label={titleOf(options?.label, side)}
        {...common}
      />
    );
  };
  // A series' axes: a vertical chart names its value axis as the y axis; a horizontal one its value axis as the x axis and the categories as the y axis.
  const axesOf = (index: number) => {
    const side = onSecondary(index) ? 'secondary' : 'primary';
    return horizontal ? { xAxisId: side, yAxisId: CATEGORY_AXIS } : { yAxisId: side };
  };

  return (
    <div ref={measure} className={styles.fill} role="figure" aria-label={label}>
      <ChartShell
        drillDown={render.drill_down === true}
        laidOut={laidOut}
        table={table}
        label={texts.dataOf(label)}
        texts={texts}
        format={(value, column) => formatColumn(column)(value)}
        locale={locale}
        container={container}
        draw={(onPick) => (
          <ChartContainer config={config} style={FILL}>
            <ComposedChart
              data={rows}
              layout={horizontal ? 'vertical' : 'horizontal'}
              margin={{
                top: horizontal ? 8 : showValues && hasEndLabel ? 34 : showValues || hasEndLabel || hasMaxMark ? 20 : 8,
                // A horizontal chart writes bar values and line names right of their ends.
                right: horizontal ? (showValues || hasEndLabel ? 48 : 16) : secondary ? 0 : 8,
                bottom: 0,
                left: rotatedOverhang,
              }}
              onClick={
                onPick
                  ? (state) => {
                      const index = pickIndexOf(state);
                      if (index !== null) onPick(index);
                    }
                  : undefined
              }
            >
              <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
              {horizontal ? (
                <YAxis
                  yAxisId={CATEGORY_AXIS}
                  dataKey="x"
                  type="category"
                  width={categoryWidth}
                  tick={TICK}
                  tickFormatter={(value: string | number) => axisTick(value)}
                  label={titleOf(render.x_axis?.label, 'primary')}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={every ? 0 : 4}
                  interval={every ? tickStep - 1 : undefined}
                />
              ) : (
                <XAxis
                  dataKey="x"
                  type={axis === 'category' ? 'category' : 'number'}
                  domain={axis === 'category' ? undefined : ['dataMin', 'dataMax']}
                  tickFormatter={(value: string | number) => axisTick(value)}
                  label={titleOf(render.x_axis?.label, 'x')}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={every ? 0 : TICK_GAP.auto}
                  interval={every ? tickStep - 1 : undefined}
                  {...xTick}
                  height={xAxisHeight(longest)}
                />
              )}
              {valueAxis('primary')}
              {secondary ? valueAxis('secondary') : null}
              {sizedSeries.map((index) => (
                <ZAxis key={`z${index}`} zAxisId={`z${index}`} type="number" dataKey={`z${index}`} name={sizeLabel} domain={[0, bubbles.largest]} range={[0, bubbles.largest]} />
              ))}
              <ChartTooltip
                content={(props) => (
                  <ChartTooltipContent
                    {...props}
                    // Only the series delivered at the hovered x: a drawn-only value between a line's own points is never shown.
                    // An entry's name is its dataKey (`s<i>`), the Recharts fallback for an item without a `name`.
                    payload={props.payload?.filter((item) => `v${String(item.name).slice(1)}` in ((item.payload as Row | undefined) ?? {}))}
                    // The kit resolves a numeric label through the config, so the x comes from the hovered row itself.
                    labelFormatter={(value, payload) => {
                      const x = (payload?.[0] as { payload?: Row } | undefined)?.payload?.x;
                      return xText(x === undefined ? (value as string | number) : x);
                    }}
                    // The delivered value, not the drawn one, which is a running total on a stacked line or a share under a
                    // percent stack; there the share follows it, and a sized point's size.
                    formatter={tooltipFormatter((key, value, item) => {
                      const row = (item as { payload?: Row } | undefined)?.payload;
                      const index = Number(key.slice(1));
                      const delivered = row?.[`v${index}`];
                      const text = formatSeries(index)(typeof delivered === 'number' ? delivered : value);
                      const part = row?.[`p${index}`];
                      const size = row?.[`size${index}`];
                      return [text, typeof part === 'number' ? `(${formatShare(share, part)})` : '', typeof size === 'number' ? `${sizeLabel} ${formatSize(size)}` : ''].filter(Boolean).join(' ');
                    })}
                  />
                )}
              />
              {legendOf(legend)}
              {referenceLinesOf(render.reference_lines, horizontal, axis)}
              {data.series.map((series, index) => {
                const key = `s${index}`;
                const option = optionOf(series.name);
                const axes = axesOf(index);
                const dash = option?.line_style === 'dashed' ? '4 4' : undefined;
                const last = lastDrawn(index);
                const name = option?.label ? (
                  <LabelList dataKey={key} content={<EndLabel text={option.label} last={last} tops={horizontal ? [] : [...labelledTops(last), ...extremeTops(index, last)]} horizontal={horizontal} />} />
                ) : null;
                const marks = extremesOf(index);
                const extremes =
                  marks.min !== undefined || marks.max !== undefined ? (
                    <LabelList
                      dataKey={key}
                      content={
                        <ExtremeMark
                          marks={marks}
                          color={`var(--color-${key})`}
                          horizontal={horizontal}
                          labelled={!compact}
                          text={(row) => {
                            const value = rows[row]?.[`v${index}`];
                            return typeof value === 'number' ? formatSeries(index)(value) : '';
                          }}
                        />
                      }
                    />
                  ) : null;
                // The hover dot marks a delivered point only, never a drawn-only value between a line's points.
                const activeDot = (dot: { cx?: number; cy?: number; payload?: Row }) =>
                  typeof dot.payload?.[`v${index}`] === 'number' ? <circle cx={dot.cx} cy={dot.cy} r={4} fill={`var(--color-${key})`} stroke="var(--background)" strokeWidth={2} /> : <g />;
                switch (typeOf(series.name)) {
                  case 'bar':
                    return (
                      <Bar
                        key={key}
                        {...axes}
                        dataKey={key}
                        stackId={option?.stack_group}
                        fill={`var(--color-${key})`}
                        radius={option?.stack_group ? 0 : horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]}
                        isAnimationActive={false}
                        onClick={onPick ? (_entry: unknown, barIndex: number) => onPick(barIndex) : undefined}
                      >
                        {/* The label shows the delivered value, also where the bar stands at its share of a percent stack. */}
                        {showValues ? (
                          <LabelList
                            dataKey={`v${index}`}
                            position={horizontal ? 'right' : 'top'}
                            offset={4}
                            className={styles.valueLabel}
                            formatter={(value) => (typeof value === 'number' ? formatSeries(index)(value) : '')}
                          />
                        ) : null}
                      </Bar>
                    );
                  case 'area':
                    return (
                      <Area key={key} {...axes} dataKey={key} stackId={option?.stack_group} type="monotone" stroke={`var(--color-${key})`} strokeDasharray={dash} fill={`var(--color-${key})`} fillOpacity={0.12} strokeWidth={2} activeDot={activeDot} isAnimationActive={false}>
                        {name}
                        {extremes}
                      </Area>
                    );
                  case 'scatter':
                    return <Scatter key={key} {...axes} zAxisId={sizedSeries.includes(index) ? `z${index}` : undefined} dataKey={key} fill={`var(--color-${key})`} isAnimationActive={false} />;
                  default:
                    return (
                      <Line key={key} {...axes} dataKey={key} type="monotone" stroke={`var(--color-${key})`} strokeDasharray={dash} strokeWidth={2} dot={false} activeDot={activeDot} isAnimationActive={false}>
                        {name}
                        {extremes}
                      </Line>
                    );
                }
              })}
            </ComposedChart>
          </ChartContainer>
        )}
      />
      <ValuesText caption={label} columns={table.columns} rows={table.rows.map((values) => values.map((value, column) => formatColumn(column)(value)))} />
    </div>
  );
}
