import { Fragment, useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Text } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, textOf, nonFiniteProblemOf } from '../format';
import { DEFAULT_WIDGET_TEXTS, ValuesText, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import type { HeatmapData, HeatmapRender } from '../types';
import { ChartShell } from '../chart/ChartShell';
import type { ValuesTable } from '../chart/DataView';
import { dayOf } from '../time';
import styles from '../widgets.module.css';

/** From this much of the scale up, a tile's fill is dark enough for its value to read in the foreground over it. */
const STRONG_FROM = 60;
/** The least room between two x labels of a matrix that names only every second (or third, ...) column. */
const LABEL_SPACE = 4;

/** Which x categories a matrix names under its columns: every `step`-th from the first, each at most `room` px wide. */
interface ColumnLabels {
  step: number;
  room: number;
  /** Whether the first named label starts at its column instead of centring under it, as centring would cross the grid's start. */
  firstAtStart: boolean;
}

/**
 * The x labels of a matrix with columns `track` px wide, `gap` px apart, under labels as wide as `widths`: every one
 * while the widest fits its column; otherwise every `step`-th, the smallest step that lets the widest label stand whole
 * under its own column, centred, clear of the next named one. An edge label stands off centre, (widest - track) / 2
 * nearer its named neighbour: the last column's label when it is named (it ends at the grid's end), and the first
 * column's when centring would cross the grid's start, as the room left of the first column, `before`, is less than
 * that shift. The step counts that shift too, twice when the two edge labels are neighbours, so an edge label keeps the
 * same space to its neighbour. With few columns no step may fit: the loop stops at the column count, so only the first
 * label is named, at most `room` wide, and the kit's text cuts it. A single column's label ends at the grid's end, at
 * most its column and `before` wide.
 */
function columnLabelsOf(track: number, gap: number, widths: number[], before: number): ColumnLabels {
  const widest = widths.reduce((most, width) => Math.max(most, width), 0);
  // A width is read in whole pixels: half a pixel over the column still fits it.
  if (!(track > 0) || widest - 0.5 <= track) return { step: 1, room: track, firstAtStart: false };
  const shift = (widest - track) / 2;
  const firstAtStart = shift > before;
  const fits = (step: number) => {
    const pitch = step * (track + gap);
    if (widest + LABEL_SPACE > pitch - gap) return false;
    const lastNamed = (widths.length - 1) % step === 0;
    if (!firstAtStart && !lastNamed) return true;
    // Centres a pitch apart, the edge label moved by the shift towards its neighbour: the space between the two is
    // pitch - shift - widest, which must hold the label space. When the first and the last named labels are
    // neighbours, both move towards each other, so the space between them loses the shift twice.
    const shifts = firstAtStart && lastNamed && widths.length - 1 === step ? 2 : 1;
    return widest + shifts * shift + LABEL_SPACE <= pitch;
  };
  let step = 2;
  while (step < widths.length && !fits(step)) step += 1;
  // A single column is also the last, so its label ends at the grid's end: it may reach back only over its column
  // and the room left of it, never past the grid's start.
  const room = widths.length === 1 ? track + before : step * (track + gap) - gap;
  return { step, room, firstAtStart: (Math.min(widest, room) - track) / 2 > before };
}

/** The class and the inline style of the x label at `index` of `count`: a named one stands whole, an edge one at its edge. */
function columnLabelOf(index: number, count: number, labels: ColumnLabels): { className: string; style?: CSSProperties } {
  if (labels.step === 1) return { className: styles.heatColumnAxis };
  if (index % labels.step !== 0) return { className: `${styles.heatColumnAxis} ${styles.heatColumnAxisSkipped}` };
  let justifySelf: 'start' | 'end' | undefined;
  if (index === count - 1) justifySelf = 'end';
  else if (index === 0 && labels.firstAtStart) justifySelf = 'start';
  return { className: `${styles.heatColumnAxis} ${styles.heatColumnAxisThin}`, style: { maxInlineSize: labels.room, justifySelf } };
}

const sameLabels = (a: ColumnLabels, b: ColumnLabels) => a.step === b.step && a.room === b.room && a.firstAtStart === b.firstAtStart;

/** A cell's key: kind and text of a value, so 1 and "1" stay different cells. */
const keyOf = (value: string | number | null) => `${typeof value}:${String(value)}`;
/** One tile's key: an unambiguous pair, so no two category labels can collide. */
const tileKey = (x: string | number | null, y: string | number | null) => JSON.stringify([x, y]);
/** The most tiles a heatmap draws; more fail the widget's own check instead of exhausting the page. */
export const MAX_HEATMAP_TILES = 10_000;

const DAY_MS = 86_400_000;

// @cpt-algo:cpt-frontx-dashboard-algo-widget-catalog-heatmap-checks:p2
/**
 * The heatmap's own check of its render and rows: the problem, or null. The text names the scale ends,
 * the fields and the row index, never data content.
 */
export function checkHeatmap(render: HeatmapRender, data?: HeatmapData): string | null {
  const { min_value, max_value } = render;
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-heatmap-checks:p2:inst-wc-heat-min-max
  if (min_value !== null && min_value !== undefined && max_value !== null && max_value !== undefined && min_value > max_value)
    return `heatmap: min_value ${min_value} is greater than max_value ${max_value}`;
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-heatmap-checks:p2:inst-wc-heat-min-max
  const calendar = render.mode === 'calendar';
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-heatmap-checks:p2:inst-wc-heat-week-start
  if (!calendar && render.week_start !== undefined) return `heatmap: week_start applies only in calendar mode, and the mode is ${render.mode ?? 'matrix'}`;
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-heatmap-checks:p2:inst-wc-heat-week-start
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-heatmap-checks:p2:inst-wc-heat-calendar-rows
  if (calendar && data) {
    for (const [index, row] of data.rows.entries()) {
      if (row.y !== undefined && row.y !== null) return `heatmap: row ${index} has a y, and calendar mode takes none`;
      if (dayOf(row.x) === null) return `heatmap: row ${index} has an x that is not a YYYY-MM-DD date, as calendar mode needs`;
    }
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-heatmap-checks:p2:inst-wc-heat-calendar-rows
  return null;
}

/** One drawn tile: where it stands, its name, its value, and the delivered row it shows. */
interface Tile {
  key: string;
  name: string;
  value: number | null;
  row: number | null;
  /** Calendar mode: the tile's grid column and row. */
  at?: CSSProperties;
}

/**
 * The `heatmap` widget: a CSS grid of tiles, with no chart library, whose fill mixes a kit chart
 * colour token over the card surface by the value's place on the scale. Matrix mode draws x by y
 * categories; calendar mode draws one tile per day, a column per week and a row per weekday, with the
 * months above the columns. Colour is never the only signal: every tile names its place and value,
 * and the delivered values stand in a visually hidden table. With drill_down the tiles are buttons
 * that open the data view with their row picked.
 */
export function Heatmap({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
  label: labelProp,
  container,
}: {
  payload: RenderWidgetPayload<HeatmapRender, HeatmapData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  const label = labelProp ?? texts.chart;
  // Calendar mode measures its box as it is laid out: whether it scrolls sideways, and which values fit their tiles.
  const [calendarBox, setCalendarBox] = useState<HTMLDivElement | null>(null);
  const [calendarScrolls, setCalendarScrolls] = useState(false);
  // Matrix mode measures its columns and x labels as they are laid out: a label wider than its column names fewer columns.
  const [matrixGrid, setMatrixGrid] = useState<HTMLDivElement | null>(null);
  const [columnLabels, setColumnLabels] = useState<ColumnLabels>({ step: 1, room: 0, firstAtStart: false });
  useLayoutEffect(() => {
    if (!matrixGrid) return;
    const fit = () => {
      const tile = matrixGrid.querySelector<HTMLElement>(`.${styles.heatCell}`);
      const labels = [...matrixGrid.querySelectorAll<HTMLElement>(`.${styles.heatColumnAxis}`)];
      if (!tile || labels.length === 0) return;
      const box = tile.getBoundingClientRect();
      const gap = Number.parseFloat(getComputedStyle(matrixGrid).columnGap) || 0;
      // Every label stays in the layout, the skipped ones unseen, so its whole text width reads at every step.
      const next = columnLabelsOf(box.width, gap, labels.map((label) => label.scrollWidth), box.left - matrixGrid.getBoundingClientRect().left);
      setColumnLabels((current) => (sameLabels(current, next) ? current : next));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(matrixGrid);
    return () => observer.disconnect();
  }, [matrixGrid, payload, locale]);
  useLayoutEffect(() => {
    if (!calendarBox) return;
    const fit = () => {
      setCalendarScrolls(calendarBox.scrollWidth > calendarBox.clientWidth);
      // A value is shown whole or not at all: one that its tile would cut is hidden, and the tile still names it.
      // All are shown first and measured together, then the cut ones are hidden, so the page is laid out once.
      const values = [...calendarBox.querySelectorAll<HTMLElement>('[data-heat-value]')];
      for (const value of values) value.hidden = false;
      const cut = values.map((value) => {
        const tile = value.parentElement as HTMLElement;
        return tile.scrollWidth > tile.clientWidth || tile.scrollHeight > tile.clientHeight;
      });
      values.forEach((value, index) => {
        value.hidden = cut[index];
      });
    };
    // The box keeps its size when the tiles change theirs, so the grid inside it is watched too.
    const observer = new ResizeObserver(fit);
    observer.observe(calendarBox);
    if (calendarBox.firstElementChild) observer.observe(calendarBox.firstElementChild);
    return () => observer.disconnect();
  }, [calendarBox, payload, locale]);
  if (!data) return <WidgetCannotBeShown texts={texts} problem="heatmap: no data" />;
  const nonFinite = nonFiniteProblemOf('heatmap', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  const problem = checkHeatmap(render, data);
  if (problem) return <WidgetCannotBeShown texts={texts} problem={problem} />;
  // The empty condition of the data type: no rows.
  if (data.rows.length === 0) return <WidgetEmpty texts={texts} />;

  const rows = data.rows;
  const calendar = render.mode === 'calendar';

  // The scale ends: those the render sets, or the lowest and highest delivered value.
  const delivered = rows.flatMap((row) => (row.value === null ? [] : [row.value]));
  const lowest = delivered.reduce((least, value) => Math.min(least, value), Number.POSITIVE_INFINITY);
  const highest = delivered.reduce((most, value) => Math.max(most, value), Number.NEGATIVE_INFINITY);
  // An end the render does not set comes from the data, but never crosses the end it does set.
  const scaleMin = render.min_value ?? (render.max_value == null ? lowest : Math.min(lowest, render.max_value));
  const scaleMax = render.max_value ?? (render.min_value == null ? highest : Math.max(highest, render.min_value));
  // Half the span, from the halves of the ends: the span of two ends far apart (1.5e308 and -1.5e308) is beyond the
  // largest number, its half never is, and a place on the scale is the same ratio of halves.
  const halfSpan = scaleMax / 2 - scaleMin / 2;
  // The value's place on the scale, as the percent of the kit colour the tile mixes over the card surface.
  // A scale of one point: with only min_value set every value sits at or under it and is empty; otherwise a value at
  // or above the point is full (all delivered values equal, or only max_value set) and one below it is empty.
  const onlyMin = render.min_value != null && render.max_value == null;
  const mixOf = (value: number) =>
    halfSpan > 0 ? Math.min(100, Math.max(0, Math.round(((value / 2 - scaleMin / 2) / halfSpan) * 100))) : !onlyMin && value >= scaleMax ? 100 : 0;
  const shown = (value: number | null) => formatValue(value, value_format, locale);

  // The values table of the data view and the text alternative: calendar rows carry no y.
  const xHeading = render.x_axis_label ?? texts.columns.x;
  const table: ValuesTable = calendar
    ? { columns: [xHeading, texts.columns.value], rows: rows.map((row) => [row.x, row.value]) }
    : { columns: [xHeading, render.y_axis_label ?? texts.columns.y, texts.columns.value], rows: rows.map((row) => [row.x, row.y ?? null, row.value]) };
  const valueColumn = table.columns.length - 1;
  const format = (value: string | number | null, column: number) => (column === valueColumn ? shown(value as number | null) : textOf(value, undefined, locale));

  /** One tile: an image named by its place and value, or with drill-down a button that picks its row. */
  const tileOf = ({ key, name, value, row, at }: Tile, onPick: ((row: number) => void) | undefined) => {
    const mix = value === null ? null : mixOf(value);
    const common = {
      title: name,
      'aria-label': name,
      className: value === null ? `${styles.heatCell} ${styles.heatEmpty}` : styles.heatCell,
      'data-strong': mix !== null && mix >= STRONG_FROM ? 'true' : undefined,
      style: mix === null ? at : ({ ...at, '--heat-mix': `${mix}%` } as CSSProperties),
    };
    const content = render.show_cell_values === true && value !== null ? <span data-heat-value="">{shown(value)}</span> : null;
    // A tile with no delivered row has nothing to open: it stays an image even with drill-down on.
    if (onPick && row !== null)
      return (
        <button key={key} type="button" {...common} className={`${common.className} ${styles.heatButton}`} onClick={() => onPick(row)}>
          {content}
        </button>
      );
    return (
      <span key={key} role="img" {...common}>
        {content}
      </span>
    );
  };

  let draw: (onPick: ((row: number) => void) | undefined) => ReactNode;
  if (calendar) {
    // The span alone is checked against the tile limit first: two far dates must not build their grid.
    const span = calendarSpanOf(rows, render.week_start ?? 'monday');
    if (span.weeks * 7 > MAX_HEATMAP_TILES)
      return <WidgetCannotBeShown texts={texts} problem={`heatmap: ${span.weeks} weeks of 7 days is over the ${MAX_HEATMAP_TILES} tile limit`} />;
    const layout = calendarOf(rows, span, locale);
    // The box sizes the tiles: they take the most room its width and height leave them, within the bounds the styles set.
    // When even the smallest tiles do not fit its width, it scrolls sideways, and then it is a named stop of the Tab order.
    draw = (onPick) => (
      <>
      <div
        ref={setCalendarBox}
        className={styles.heatCalendarBox}
        {...(calendarScrolls ? { tabIndex: 0, role: 'region', 'aria-label': label } : {})}
      >
        <div
          className={render.show_cell_values === true ? `${styles.heatGrid} ${styles.heatCalendar} ${styles.heatValues}` : `${styles.heatGrid} ${styles.heatCalendar}`}
          style={{ '--heat-weeks': layout.weeks, gridTemplateColumns: `var(--heat-day-label) repeat(${layout.weeks}, var(--heat-tile))` } as CSSProperties}
        >
          {/* The month labels stand over the first week of each month, each as wide as the weeks up to the next one. */}
          <span aria-hidden="true" />
          {layout.months.map((month) => (
            <Text
              key={month.start}
              typography="micro"
              tone="muted"
              render={<span />}
              className={styles.heatMonth}
              style={{ gridColumn: `${month.start + 2} / ${month.end + 2}`, gridRow: 1 }}
            >
              {month.name}
            </Text>
          ))}
          {layout.weekdays.map((weekday, line) => (
            <Text key={weekday} typography="micro" tone="muted" render={<span />} className={styles.heatRowAxis} style={{ gridColumn: 1, gridRow: line + 2 }}>
              {/* Every second weekday is named (Monday, Wednesday, Friday, and Sunday when it ends the week), as the tiles are too low for seven labels. */}
              {(line + (render.week_start === 'sunday' ? 0 : 1)) % 2 === 1 ? weekday : null}
            </Text>
          ))}
          {/* The tiles week by week, so the page order, the Tab order and a screen reader follow the dates; the grid places each. */}
          {layout.days.map((week, column) =>
            week.map((day, line) =>
              day === null ? (
                <span key={`${column}:${line}`} aria-hidden="true" style={{ gridColumn: column + 2, gridRow: line + 2 }} />
              ) : (
                tileOf(
                  {
                    key: day.date,
                    name: day.value === null ? day.text : `${day.text}: ${shown(day.value)}`,
                    value: day.value,
                    row: day.row,
                    at: { gridColumn: column + 2, gridRow: line + 2 },
                  },
                  onPick,
                )
              ),
            ),
          )}
        </div>
      </div>
      {render.x_axis_label !== undefined ? (
        <Text typography="meta" tone="muted" render={<span />} className={`${styles.heatTitle} ${styles.heatTitleX}`}>
          {render.x_axis_label}
        </Text>
      ) : null}
      </>
    );
  } else {
    // The categories keep the order of their first appearance in the delivered rows. A combination the
    // rows did not deliver, and a null value, leaves its tile empty. An omitted y is a null y.
    const xs = [...new Set(rows.map((row) => row.x))];
    const ys = [...new Set(rows.map((row) => row.y ?? null))];
    if (xs.length * ys.length > MAX_HEATMAP_TILES) return <WidgetCannotBeShown texts={texts} problem={`heatmap: ${xs.length} x ${ys.length} tiles is over the ${MAX_HEATMAP_TILES} tile limit`} />;
    // The last delivered row of a pair sets its tile, and is the row its tile picks.
    const rowAt = new Map(rows.map((row, index) => [tileKey(row.x, row.y ?? null), index] as const));
    const place = (x: string | number | null, y: string | number | null) => [textOf(x, undefined, locale), textOf(y, undefined, locale)].filter(Boolean).join(', ');
    draw = (onPick) => (
      <div
        ref={setMatrixGrid}
        className={render.show_cell_values === true ? `${styles.heatGrid} ${styles.heatValues}` : styles.heatGrid}
        style={{ gridTemplateColumns: `auto repeat(${xs.length}, minmax(0, 1fr))` }}
      >
        {/* The y-axis title stands over the row labels; the row of x categories, and the x-axis title under it, leave their first cell empty. */}
        {render.y_axis_label !== undefined ? (
          <>
            <Text typography="meta" tone="muted" render={<span />} className={styles.heatTitle}>
              {render.y_axis_label}
            </Text>
            {xs.map((_x, index) => (
              <span key={index} aria-hidden="true" />
            ))}
          </>
        ) : null}
        {ys.map((y) => (
          <Fragment key={keyOf(y)}>
            <Text typography="micro" tone="muted" render={<span />} className={styles.heatRowAxis} title={textOf(y, undefined, locale)}>
              {textOf(y, undefined, locale)}
            </Text>
            {xs.map((x) => {
              const row = rowAt.get(tileKey(x, y)) ?? null;
              const value = row === null ? null : rows[row].value;
              const where = place(x, y);
              return tileOf({ key: keyOf(x), name: value === null ? where : `${where}: ${shown(value)}`, value, row }, onPick);
            })}
          </Fragment>
        ))}
        <span aria-hidden="true" />
        {xs.map((x, index) => {
          // Labels wider than their columns name every step-th column: each named one stands whole under its own
          // column, centred over the unnamed ones beside it; the last column's label ends at the grid's end.
          const { className, style } = columnLabelOf(index, xs.length, columnLabels);
          return (
            <Text
              key={keyOf(x)}
              typography="micro"
              tone="muted"
              render={<span />}
              className={className}
              style={style}
              title={textOf(x, undefined, locale)}
            >
              {textOf(x, undefined, locale)}
            </Text>
          );
        })}
        {render.x_axis_label !== undefined ? (
          <>
            <span aria-hidden="true" />
            <Text
              typography="meta"
              tone="muted"
              render={<span />}
              className={`${styles.heatTitle} ${styles.heatTitleX}`}
              style={{ gridColumn: `2 / span ${xs.length}` }}
            >
              {render.x_axis_label}
            </Text>
          </>
        ) : null}
      </div>
    );
  }

  // The colour scale, with its ends as numbers.
  const legend =
    Number.isFinite(scaleMin) && Number.isFinite(scaleMax) && halfSpan >= 0 ? (
      <div className={styles.heatLegend}>
        <Text typography="micro" tone="muted" render={<span />}>
          {shown(scaleMin)}
        </Text>
        <span className={styles.heatScale} aria-hidden="true" />
        <Text typography="micro" tone="muted" render={<span />}>
          {shown(scaleMax)}
        </Text>
      </div>
    ) : null;

  return (
    <div className={styles.heat} role="figure" aria-label={label}>
      {render.drill_down === true ? (
        <ChartShell
          drillDown
          table={table}
          label={texts.dataOf(label)}
          texts={texts}
          format={format}
          locale={locale}
          container={container}
          draw={(onPick) => (
            <div className={styles.heatBody}>
              {draw(onPick)}
              {legend}
            </div>
          )}
        />
      ) : (
        <>
          {draw(undefined)}
          {legend}
        </>
      )}
      {/* A text alternative of the delivered values, in delivered order. */}
      <ValuesText caption={label} columns={table.columns} rows={table.rows.map((values) => values.map((value, column) => format(value, column)))} />
    </div>
  );
}

/** One day of the calendar: its date, its name, its value, and the delivered row that set it (null: no row). */
interface CalendarDay {
  date: string;
  text: string;
  value: number | null;
  row: number | null;
}

/**
 * The span of a calendar of checked rows: its earliest and latest day, the first day of the week holding the
 * earliest, and the number of weeks up to the one holding the latest. One pass over the rows, so the tile limit
 * is checked before any grid is built, and a list of any length is read without spreading it into a call.
 */
function calendarSpanOf(rows: HeatmapData['rows'], weekStart: 'monday' | 'sunday') {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const day = dayOf(row.x) as number;
    if (day < first) first = day;
    if (day > last) last = day;
  }
  const offset = weekStart === 'monday' ? 1 : 0;
  const lead = (new Date(first).getUTCDay() - offset + 7) % 7;
  const start = first - lead * DAY_MS;
  return { first, last, start, offset, weeks: Math.floor((last - start) / DAY_MS / 7) + 1 };
}

/**
 * The calendar layout of checked rows within their span: the weeks from the one holding the earliest date to
 * the one holding the latest, each a column of seven weekdays from the week's start; a day outside the
 * delivered range is null (no tile), a day inside it without a row is an empty tile. A month is labelled over
 * the first week that starts in it (the first week, over its first day in the range); a label narrower than
 * two weeks is left out.
 */
function calendarOf(rows: HeatmapData['rows'], { first, last, start, offset, weeks }: ReturnType<typeof calendarSpanOf>, locale: string) {
  // The last delivered row of a date sets its tile.
  const rowOn = new Map(rows.map((row, index) => [dayOf(row.x) as number, index] as const));
  const dateText = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const monthText = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const weekdayText = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  // 2026-11-01 was a Sunday: the weekday names in order from the week's start.
  const weekdays = Array.from({ length: 7 }, (_, line) => weekdayText.format(Date.UTC(2026, 10, 1 + offset + line)));
  // Week by week, each from its first weekday, so the tiles stand in date order.
  const weekList: (CalendarDay | null)[][] = Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, line) => {
      const time = start + (week * 7 + line) * DAY_MS;
      if (time < first || time > last) return null;
      const row = rowOn.get(time) ?? null;
      return { date: new Date(time).toISOString().slice(0, 10), text: dateText.format(time), value: row === null ? null : rows[row].value, row };
    }),
  );
  const starts: { start: number; name: string }[] = [];
  for (let week = 0; week < weeks; week += 1) {
    // The month of the week's first day in the range: a new month gets its label over this week.
    const time = Math.max(start + week * 7 * DAY_MS, first);
    const month = new Date(time).getUTCMonth();
    if (week === 0 || new Date(Math.max(start + (week - 1) * 7 * DAY_MS, first)).getUTCMonth() !== month) starts.push({ start: week, name: monthText.format(time) });
  }
  const months = starts.map((month, index) => ({ ...month, end: starts[index + 1]?.start ?? weeks })).filter((month) => month.end - month.start >= 2);
  return { weeks, weekdays, days: weekList, months };
}
