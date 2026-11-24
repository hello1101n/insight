import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Polygon, Radar, RadarChart as RechartsRadarChart, useChartHeight, useChartWidth, usePlotArea, type Coordinate } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, nonFiniteProblemOf, textOf } from '../format';
import { DEFAULT_WIDGET_TEXTS, ValuesText, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import type { RadarData, RadarRender } from '../types';
import { PALETTE, legendOf } from './legend';
import { ChartShell } from './ChartShell';
import { FILL, pickIndexOf, TICK, TICK_CHAR_WIDTH, TICK_TEXT_HEIGHT } from './chrome';
import type { ValuesTable } from './DataView';
import { isLaidOut, useElementSize } from './size';
import { compactTick } from './ticks';
import styles from '../widgets.module.css';

/** The bounds the widget checks itself, as the data type cannot count the distinct axes and series of the long format. */
const MIN_AXES = 3;
const MAX_AXES = 12;
// One series per tone of the palette: polygons overlap by design, so no two series may share a colour.
const MAX_SERIES = PALETTE.length;

// The area of a series, over its stroke of the same tone, when `fill` keeps it.
const AREA_OPACITY = 0.25;

// Recharts sizes the circle from the plot area (the chart inside its 5 px margins, less a legend above, under or beside
// it), at 80% of the half of its shorter side (its own default outer radius), and centres it in the whole chart, not
// in the plot area, so a legend under the chart leaves more room above the circle than under it. Px here, measured in
// the browser, because the fit of the axis labels is judged from the chart's pixel size as it lays it out.
const OUTER_SHARE = 0.8;
const CHART_MARGIN = 5;
// A label beside the circle starts its tick size (8 px) out of it.
const TICK_SIZE = 8;
// A label above or under the circle ends one tick text line out of its vertex, its box starting 5 px out.
const LABEL_REACH = 5 + TICK_TEXT_HEIGHT;
// The kit legend pads its entries 12 px on the side that faces the plot; a label above or under the circle may reach
// into that padding. The 12 px is the padding measured in the browser for the pinned ui-kit 0.5.0
// (widgets/package.json), not a spacing the kit promises: a change of the kit's legend spacing must measure it again.
// Beside the circle it may not, on purpose: the label's width there is a coarse per-character estimate, and the
// browser measure shows a side legend counted from the chart centre to the plot edge with no padding.
const LEGEND_PADDING = 12;
// The room a label keeps clear of an edge or a legend.
const FIT_MARGIN = 2;

/**
 * Whether the axis labels fit between the circle and the edges of the chart, or a legend beside the plot: the widest
 * label beside the circle on the horizontal ends, the label of the first axis, which points straight up, above it, and
 * the labels of the lowest vertex under it (the bottom of the circle for an even count of axes, higher for an odd one).
 * A low or narrow cell, or a legend under the plot, leaves little of these rooms.
 */
function labelsFit(chart: { width: number; height: number }, plot: { x: number; y: number; width: number; height: number }, axisCount: number, longest: number): boolean {
  if (plot.width <= 0 || plot.height <= 0) return true;
  const radius = (OUTER_SHARE * Math.min(plot.width, plot.height)) / 2;
  const legendAt = (offset: number, padding: number) => (offset > CHART_MARGIN ? Math.max(0, offset - padding) : 0);
  const centreX = chart.width / 2;
  const centreY = chart.height / 2;
  const left = centreX - legendAt(plot.x, 0);
  const right = chart.width - legendAt(chart.width - plot.x - plot.width, 0) - centreX;
  const above = centreY - legendAt(plot.y, LEGEND_PADDING);
  const under = chart.height - legendAt(chart.height - plot.y - plot.height, LEGEND_PADDING) - centreY;
  const lowest = axisCount % 2 === 0 ? radius : radius * Math.cos(Math.PI / axisCount);
  const beside = radius + TICK_SIZE + longest * TICK_CHAR_WIDTH + FIT_MARGIN;
  return beside <= Math.min(left, right) && radius + LABEL_REACH + FIT_MARGIN <= above && lowest + LABEL_REACH + FIT_MARGIN <= under;
}

/**
 * The axis of the spokes. A cell of any height hides all the axis labels when the longest cannot fit in the chart
 * beside the plot area its legend leaves, and keeps them in the tooltip and the text alternative; before the chart is
 * laid out the labels are kept.
 */
function AngleAxis({ axisCount, longest }: { axisCount: number; longest: number }) {
  const plot = usePlotArea();
  const width = useChartWidth();
  const height = useChartHeight();
  const showLabels = !plot || !width || !height || labelsFit({ width, height }, plot, axisCount, longest);
  return <PolarAngleAxis dataKey="axis" tick={showLabels ? TICK : false} tickLine={false} />;
}

/** A row of the drawn table: one axis of the radar, with the value of each series that delivered a point on it. */
type Row = { axis: string; [key: string]: string | number | null | undefined };

// @cpt-algo:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2
/**
 * The radar's own check of its data: the first negative value, the first point that would add an axis or a series
 * beyond what a radar takes, and the first point that repeats the axis and the series of an earlier one, which would
 * hide that earlier value, each named by its position and never by its value, then fewer than 3 distinct axes, which
 * draw a dot or a line and no polygon (the data type counts the points, not the axes), or null.
 */
export function checkRadar(data: RadarData): string | null {
  const axes: string[] = [];
  const series: (string | null)[] = [];
  const pairs = new Set<string>();
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-for-point
  for (const [index, point] of data.points.entries()) {
    // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-negative
    if (point.value !== null && point.value < 0) return `radar_chart: data.points[${index}].value is below 0`;
    // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-negative
    // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-axes
    if (!axes.includes(point.axis)) {
      if (axes.length === MAX_AXES) return `radar_chart: data.points[${index}].axis would be a ${MAX_AXES + 1}th axis, and a radar takes at most ${MAX_AXES}`;
      axes.push(point.axis);
    }
    // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-axes
    // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-series
    if (!series.some((name) => name === point.series)) {
      if (series.length === MAX_SERIES) return `radar_chart: data.points[${index}].series would be a ${MAX_SERIES + 1}th series, and a radar takes at most ${MAX_SERIES}`;
      series.push(point.series);
    }
    // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-series
    // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-repeat
    // JSON keeps the unnamed series (null) apart from a series named "null".
    const pair = JSON.stringify([point.axis, point.series]);
    if (pairs.has(pair)) return `radar_chart: data.points[${index}] repeats the axis and the series of an earlier point`;
    pairs.add(pair);
    // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-repeat
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-for-point
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-min-axes
  if (axes.length < MIN_AXES) return `radar_chart: data.points has ${axes.length} distinct ${axes.length === 1 ? 'axis' : 'axes'}, and a radar takes at least ${MIN_AXES}`;
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-radar-min-axes
  return null;
}

/** The scale's value labels sit over the polygons: a halo in the card colour keeps them readable there. */
const RADIUS_TICK = { ...TICK, fontSize: 11, stroke: 'var(--card)', strokeWidth: 3, paintOrder: 'stroke' };

/**
 * The drawn polygon of a series: its own vertices, but none at an axis where the series has no value, which would
 * collapse to the centre of the circle. A gap leaves the boundary between the neighbouring axes.
 */
function gaplessPolygon({ baseLinePoints: _baseLinePoints, points, ...polygon }: { baseLinePoints?: unknown; points?: Array<(Coordinate & { value?: unknown }) | null> }) {
  const kept = (point: (Coordinate & { value?: unknown }) | null): point is Coordinate => point !== null && point.value !== '' && point.value !== null && point.value !== undefined;
  return <Polygon {...polygon} points={(points ?? []).filter(kept)} />;
}

/** The `radar_chart` widget: the kit chart with one Recharts radar, one spoke per axis, one polygon per series. */
export function RadarChart({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
  label: labelProp,
  container,
}: {
  payload: RenderWidgetPayload<RadarRender, RadarData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  const label = labelProp ?? texts.chart;
  const [measure, { width, height }] = useElementSize();
  if (!data) return <WidgetCannotBeShown texts={texts} problem="radar_chart: no data" />;
  const nonFinite = nonFiniteProblemOf('radar_chart', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  const problem = checkRadar(data);
  if (problem) return <WidgetCannotBeShown texts={texts} problem={problem} />;
  // Every value null or 0 draws every vertex at the centre, which shows nothing: the empty state.
  if (data.points.every((point) => !point.value)) return <WidgetEmpty texts={texts} />;

  const format = (value: string | number | null) => (typeof value === 'number' ? formatValue(value, value_format, locale) : (value ?? ''));
  // The axes in first-seen order, and the series in first-seen order; a null series is the one unnamed series.
  const axes = [...new Set(data.points.map((point) => point.axis))];
  const names: (string | null)[] = [];
  for (const point of data.points) if (!names.some((name) => name === point.series)) names.push(point.series);
  // One row per axis, one value per series on it: the check lets no axis and series pair repeat.
  const rows: Row[] = axes.map((axis) => ({ axis }));
  const byAxis = new Map(rows.map((row) => [row.axis, row]));
  for (const point of data.points) byAxis.get(point.axis)![`s${names.findIndex((name) => name === point.series)}`] = point.value;

  const config: ChartConfig = Object.fromEntries(names.map((name, index) => [`s${index}`, { label: name ?? texts.columns.series, color: PALETTE[index % PALETTE.length] }]));
  const table: ValuesTable = {
    columns: [texts.radar.axis, ...names.map((name) => name ?? texts.columns.series)],
    rows: rows.map(({ axis, ...values }) => [axis, ...names.map((_, index) => values[`s${index}`] ?? null)]),
  };
  // A legend for two series at least: with one it only repeats the cell's title.
  const legend = names.length > 1 ? render.legend_position ?? 'bottom' : 'none';
  const longest = Math.max(...axes.map((axis) => axis.length));
  // The outer circle is at least scale_max, and a larger delivered value extends it to that value; without a
  // scale_max the chart library's ticks round the largest value up.
  const largest = Math.max(...data.points.map((point) => point.value ?? 0));
  const radiusTop = render.scale_max === undefined ? 'auto' : Math.max(render.scale_max, largest);

  return (
    <div ref={measure} className={styles.fill} role="figure" aria-label={label}>
      <ChartShell
        drillDown={render.drill_down === true}
        laidOut={isLaidOut({ width, height })}
        table={table}
        label={texts.dataOf(label)}
        texts={texts}
        format={(value, column) => (column === 0 ? textOf(value, undefined, locale) : format(value))}
        locale={locale}
        container={container}
        draw={(onPick) => (
          <ChartContainer config={config} style={FILL}>
            <RechartsRadarChart
              data={rows}
              onClick={
                onPick
                  ? (state) => {
                      const index = pickIndexOf(state);
                      if (index !== null) onPick(index);
                    }
                  : undefined
              }
            >
              <PolarGrid />
              <AngleAxis axisCount={axes.length} longest={longest} />
              {/* Along the first axis, which the chart draws straight up, so the value labels read level beside it. */}
              <PolarRadiusAxis
                angle={90}
                tick={RADIUS_TICK}
                tickLine={false}
                axisLine={false}
                tickFormatter={compactTick(value_format, locale)}
                domain={[0, radiusTop]}
              />
              <ChartTooltip
                content={(props) => (
                  <ChartTooltipContent
                    {...props}
                    // Only the series with a value at the hovered axis: a gap, a null value or no point there, has no entry.
                    // The chart library leaves a gap out as well; the filter holds the rule whatever the library does.
                    // An entry's name is its series key (`s<i>`), the name its Radar carries.
                    payload={props.payload?.filter((item) => {
                      const value = (item.payload as Row | undefined)?.[String(item.name)];
                      return value !== null && value !== undefined;
                    })}
                    // The delivered value, not the drawn one, which the scale only shapes.
                    formatter={(value, key) => (
                      <span className={styles.tooltipRow}>
                        <span>{String(config[String(key)]?.label ?? '')}</span>
                        <span className={styles.tooltipValue}>{format(typeof value === 'number' ? value : null)}</span>
                      </span>
                    )}
                  />
                )}
              />
              {legendOf(legend)}
              {names.map((_, index) => (
                <Radar
                  key={`s${index}`}
                  name={`s${index}`}
                  dataKey={`s${index}`}
                  stroke={`var(--color-s${index})`}
                  strokeWidth={2}
                  fill={`var(--color-s${index})`}
                  fillOpacity={render.fill === false ? 0 : AREA_OPACITY}
                  shape={gaplessPolygon}
                  isAnimationActive={false}
                />
              ))}
            </RechartsRadarChart>
          </ChartContainer>
        )}
      />
      <ValuesText caption={label} columns={table.columns} rows={table.rows.map((row) => row.map((value, column) => (column === 0 ? textOf(value, undefined, locale) : format(value))))} />
    </div>
  );
}
