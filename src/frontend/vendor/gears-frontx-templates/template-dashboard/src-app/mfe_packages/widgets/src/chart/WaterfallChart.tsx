import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, useXAxisScale, useYAxisScale } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload, ValueFormat } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, nonFiniteProblemOf, textOf } from '../format';
import { DEFAULT_WIDGET_TEXTS, ValuesText, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import type { WaterfallData, WaterfallRender } from '../types';
import { legendOf } from './legend';
import { ChartShell } from './ChartShell';
import { FILL, pickIndexOf, TICK } from './chrome';
import type { ValuesTable } from './DataView';
import { isCompact, isLaidOut, useElementSize } from './size';
import { compactTick } from './ticks';
import { estimateWidth } from '../textFit';
import styles from '../widgets.module.css';

/*
 * The `waterfall_chart` widget: one Recharts BarChart whose steps of a running sum draw as stacked bars, a
 * transparent base under the visible one, so a delta draws from where its step starts and a total from zero. The
 * connectors and the value labels the chart lays itself, over the plot area its scales give it, so they touch the
 * bars the library computes at both ends. The value axis, the shared tooltip and the click picking of a bar come
 * from the library, as the cartesian chart takes them; the funnel and the treemap, which show no axis, draw
 * without one.
 */

// A bar is at most this wide, and never under 2 px; the bands of a narrow cell thin the bars, not the steps.
const BAR_CEILING = 56;
const BAR_FLOOR = 2;
// The room the estimate of a band leaves to the value axis and the chart's margins.
const AXIS_ROOM = 64;
// The share of a band a bar takes, so the estimate stays under the band the cell actually gives the bar.
const BAR_SHARE = 0.6;

// The width estimate of a value label, at the 10 px the labels draw at (the kit's `--text-micro-size`, 0.625rem).
const TEXT_PX = 10;
const widthOf = (text: string) => estimateWidth(text, TEXT_PX);
// The share of its band the chart library draws a bar at when the asked bar size does not fit the band. This rule,
// and the centring `barOf` rounds by, mirror the bar layout of the pinned recharts 3.10.1 (widgets/package.json):
// re-check both against the library's bar placement on any recharts upgrade.
const FULL_BAR_SHARE = 0.9;
// The tones in the order the legend names them, the rank of each.
const TONES = ['increase', 'decrease', 'total'] as const;
// A value label stands this far over the top edge of its bar, a text line of it kept by the chart's top margin.
const LABEL_LIFT = 5;
const LABEL_ROOM = 20;

// The relative room two numbers agree within for a total to be the running sum: one part in a billion.
const TOTAL_TOLERANCE = 1e-9;

/** One step of the running sum, as the chart draws it: the sums it starts and ends at, and its bar. */
interface Step {
  /** The step's position in the delivered order: its row of the data view. */
  index: number;
  /** The category the bar stands in: the position, so two steps of one name keep their own bands. */
  key: string;
  kind: 'delta' | 'total';
  /** The running sum the step starts at and ends at, the chart starting at 0. */
  start: number;
  end: number;
  /** The stacked base under the bar, and the three segments one of which the bar draws. */
  base: number;
  increase: number | null;
  decrease: number | null;
  total: number | null;
  /** The extent of the bar: a null delta draws none and leaves the sum unchanged. */
  size: number;
}

/**
 * The running sum one delivered step moves to: a first step that is a total with a value sets it, a delta with a
 * value adds to it, a null delta or a later total leaves it. The check and the drawing both move by it.
 */
function runningAfter(running: number, step: WaterfallData['steps'][number], index: number): number {
  if (step.value === null) return running;
  if ((step.kind ?? 'delta') === 'delta') return running + step.value;
  return index === 0 ? step.value : running;
}

// @cpt-algo:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2
/**
 * The waterfall's own check of its data: the first total after the first step whose delivered value is not the
 * running sum of the steps before it, the first step that moves the running sum out of the finite range, and the
 * first delta whose move from the sum it starts at to the sum it ends at rounds beyond the largest number while both
 * sums stay in range, each named by its position and never by its value, or null. A total within the relative
 * tolerance is the running sum; one with no value draws the sum the steps before it moved to. The first step may be a total: the start of the
 * sum, its value the sum begins at.
 */
export function checkWaterfall(data: WaterfallData): string | null {
  let running = 0;
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-waterfall-for-step
  for (const [index, step] of data.steps.entries()) {
    const total = (step.kind ?? 'delta') === 'total';
    const before = running;
    // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-waterfall-total
    if (total && index > 0 && step.value !== null && Math.abs(step.value - running) > TOTAL_TOLERANCE * Math.max(Math.abs(step.value), Math.abs(running))) {
      return `waterfall_chart: data.steps[${index}] is a total, and its value is not the running sum of the steps before it`;
    }
    // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-waterfall-total
    // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-waterfall-sum
    running = runningAfter(running, step, index);
    // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-waterfall-sum
    // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-waterfall-finite
    if (!Number.isFinite(running)) return `waterfall_chart: data.steps[${index}] moves the running sum out of the finite range`;
    // The extent a delta draws, as stepsOf takes it: a finite sum and a finite start can still lie further apart than
    // the largest number. A total's extent is the sum itself, finite once the check above has passed.
    if (!total && !Number.isFinite(running - before)) return `waterfall_chart: data.steps[${index}] draws a bar whose extent is beyond the finite range`;
    // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-waterfall-finite
  }
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-waterfall-for-step
  return null;
}

/** The steps of the delivered data, each with the sums it starts and ends at and the bar it draws. */
function stepsOf(data: WaterfallData): Step[] {
  const steps: Step[] = [];
  let running = 0;
  for (const [index, step] of data.steps.entries()) {
    const kind = step.kind ?? 'delta';
    const start = running;
    running = runningAfter(running, step, index);
    // A total draws the running sum from zero: its bar spans the whole sum, drawn down when the sum is below it.
    const end = running;
    const value = step.value;
    steps.push({
      index,
      key: String(index),
      kind,
      start,
      end,
      base: kind === 'total' ? Math.min(0, end) : Math.min(start, end),
      increase: kind === 'delta' && value !== null && value >= 0 ? value : null,
      decrease: kind === 'delta' && value !== null && value < 0 ? -value : null,
      total: kind === 'total' ? Math.abs(end) : null,
      size: kind === 'total' ? Math.abs(end) : Math.abs(end - start),
    });
  }
  return steps;
}

/**
 * A step's change, as its label, its tooltip entry and its data view cell read it: a delta signed, a total bare,
 * a null one empty. A delta reads its delivered value; a total one the value it draws, the running sum.
 */
function changeOf(step: WaterfallData['steps'][number], drawn: Step | undefined, value_format: ValueFormat | undefined, locale: string): string {
  if ((step.kind ?? 'delta') === 'delta') {
    if (step.value === null) return '';
    const formatted = formatValue(step.value, value_format, locale);
    return step.value > 0 ? `+${formatted}` : formatted;
  }
  return formatValue(drawn?.end ?? step.value ?? 0, value_format, locale);
}

/**
 * The connectors and value labels over the bars: a thin line from one drawn bar's end to the next drawn bar's
 * start, at the level both stand at, and a step's change over its bar when the render asks it and the label fits
 * the band the bar stands in, estimated from its length. With `auto` a label shows only in a cell that is not low,
 * where the bar leaves room over it, and only while it fits its band; `always` writes it whatever the cell and the
 * band, and `never` writes none.
 */
function Overlay({ steps, changes, barSize, mode, compact, connectors }: { steps: Step[]; changes: string[]; barSize: number; mode: 'auto' | 'always' | 'never'; compact: boolean; connectors: boolean }) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  if (!xScale || !yScale) return null;
  // The bar the chart draws, by the library's own rule: the asked width centred in its band, the room the band
  // leaves split about it and rounded; a band no wider than the asked width draws the bar at 0.9 of the band.
  const barOf = (step: Step) => {
    const start = xScale(step.key, { position: 'start' });
    const end = xScale(step.key, { position: 'end' });
    if (start === undefined || end === undefined) return null;
    const band = end - start;
    const width = barSize >= band && band > 0 ? band * FULL_BAR_SHARE : barSize;
    return { left: start + Math.round((band - width) / 2), width, band };
  };
  const lines: ReactNode[] = [];
  const texts: ReactNode[] = [];
  // The last drawn step and its bar, which the next drawn bar's connector starts from.
  let previous: { step: Step; bar: { left: number; width: number } } | null = null;
  for (const step of steps) {
    if (step.size <= 0) continue;
    const bar = barOf(step);
    if (bar === null) continue;
    if (previous && connectors) {
      const level = yScale(previous.step.end);
      if (level !== undefined) {
        lines.push(<line key={`c${step.index}`} className={styles.waterfallConnector} x1={previous.bar.left + previous.bar.width} y1={level} x2={bar.left} y2={level} />);
      }
    }
    previous = { step, bar };
    const change = changes[step.index] ?? '';
    if (change !== '' && (mode === 'always' || (mode === 'auto' && !compact && widthOf(change) <= bar.band))) {
      // The label stands over the bar's top edge: a total's top is zero when its sum is below it.
      const level = yScale(step.kind === 'total' ? Math.max(0, step.end) : Math.max(step.start, step.end));
      if (level !== undefined) {
        texts.push(
          <text key={`l${step.index}`} className={styles.valueLabel} x={bar.left + bar.width / 2} y={level - LABEL_LIFT} textAnchor="middle">
            {change}
          </text>,
        );
      }
    }
  }
  return (
    <g aria-hidden>
      {lines}
      {texts}
    </g>
  );
}

/** The `waterfall_chart` widget: the running sum of its steps, one bar per step, a total from zero. */
export function WaterfallChart({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
  label: labelProp,
  container,
}: {
  payload: RenderWidgetPayload<WaterfallRender, WaterfallData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  const label = labelProp ?? texts.chart;
  const [measure, { width, height }] = useElementSize();
  if (!data) return <WidgetCannotBeShown texts={texts} problem="waterfall_chart: no data" />;
  const nonFinite = nonFiniteProblemOf('waterfall_chart', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  const problem = checkWaterfall(data);
  if (problem) return <WidgetCannotBeShown texts={texts} problem={problem} />;

  const steps = stepsOf(data);
  // No step draws a bar of any extent: the empty state, as the funnel shows when no stage has a value.
  if (!steps.some((step) => step.size > 0)) return <WidgetEmpty texts={texts} />;

  const format = (value: string | number | null) => (typeof value === 'number' ? formatValue(value, value_format, locale) : (value ?? ''));
  const change = (index: number) => changeOf(data.steps[index], steps[index], value_format, locale);
  // The change a step's data view row holds, as its Change cell shows it: a delta its delivered value, a total the
  // running sum it draws, a null delta none. A total delivered as null shows the sum, so it sorts by it too.
  const changeValue = (index: number): number | null => {
    const step = data.steps[index];
    if ((step.kind ?? 'delta') === 'delta') return step.value;
    return steps[index]?.end ?? step.value ?? 0;
  };
  // One cell of the data view and the text alternative: the label as text, the change signed, the running total.
  const cellOf = (value: string | number | null, column: number, row: number) => {
    if (column === 0) return textOf(value, undefined, locale);
    if (column === 1) return change(row);
    return format(value);
  };
  const table: ValuesTable = {
    columns: [texts.columns.label, texts.waterfall.change, texts.waterfall.running],
    rows: steps.map((step) => [data.steps[step.index].label, changeValue(step.index), step.end]),
  };
  // The tones the drawn bars take: the legend names only these.
  const present = new Set(TONES.filter((tone) => steps.some((step) => step.size > 0 && step[tone] !== null)));
  const compact = isCompact(height);
  const mode = render.value_labels ?? 'auto';
  // A label stands over the topmost bar, so the chart keeps a text line of room above the plot when one may show.
  const labelsMayShow = mode === 'always' || (mode === 'auto' && !compact);
  // The bar the chart draws: a share of the room a band of this cell has, at least a sliver, at most a comfortable width.
  const barSize = Math.max(BAR_FLOOR, Math.min(BAR_CEILING, Math.floor((Math.max(width - AXIS_ROOM, 0) / steps.length) * BAR_SHARE)));
  const config: ChartConfig = {
    increase: { label: texts.waterfall.increase, color: 'var(--success)' },
    decrease: { label: texts.waterfall.decrease, color: 'var(--danger)' },
    total: { label: texts.waterfall.total, color: 'var(--muted-foreground)' },
  };

  return (
    <div ref={measure} className={styles.fill} role="figure" aria-label={label}>
      <ChartShell
        drillDown={render.drill_down === true}
        laidOut={isLaidOut({ width, height })}
        table={table}
        label={texts.dataOf(label)}
        texts={texts}
        format={cellOf}
        locale={locale}
        container={container}
        draw={(onPick) => (
          <ChartContainer config={config} style={FILL}>
            <BarChart
              data={steps}
              margin={{ top: labelsMayShow ? LABEL_ROOM : 8, right: 8, bottom: 0, left: 0 }}
              onClick={
                onPick
                  ? (state) => {
                      const index = pickIndexOf(state);
                      if (index !== null) onPick(index);
                    }
                  : undefined
              }
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="key"
                type="category"
                tickFormatter={(key: string) => data.steps[Number(key)]?.label ?? ''}
                tick={TICK}
                tickLine={false}
                axisLine={false}
                interval="equidistantPreserveStart"
              />
              <YAxis width={48} tick={TICK} tickLine={false} axisLine={false} tickFormatter={compactTick(value_format, locale)} />
              <ChartTooltip
                content={(props) => (
                  <ChartTooltipContent
                    {...props}
                    // Only the bar of the hovered step: the transparent base of its stack, and the two tones the
                    // step is not, have no entry, and a step that draws no bar (a delta of exactly 0, or a total
                    // whose running sum is 0) has none. An entry's name is its dataKey, the tone the step takes.
                    payload={props.payload?.filter((item) => {
                      const step = item.payload as Step | undefined;
                      if (item.dataKey === 'base' || !step || step.size <= 0) return false;
                      const value = step[String(item.dataKey) as (typeof TONES)[number]];
                      return value !== null && value !== undefined;
                    })}
                    labelFormatter={(key) => data.steps[Number(key)]?.label ?? String(key)}
                    formatter={(_value, key, item) => (
                      <span className={styles.tooltipRow}>
                        <span>{config[String(key)]?.label ?? ''}</span>
                        <span className={styles.tooltipValue}>{change((item?.payload as Step | undefined)?.index ?? 0)}</span>
                      </span>
                    )}
                  />
                )}
              />
              {legendOf('bottom', undefined, (item) => TONES.indexOf(item.dataKey as (typeof TONES)[number]))}
              {/* The stack: a transparent base under the bar, and the tone the step takes as the segment over it.
                  The base carries the bar's width, as the library takes a stack's width from its first series. */}
              <Bar dataKey="base" stackId="sum" fill="transparent" legendType="none" barSize={barSize} isAnimationActive={false} />
              {/* A tone no step takes keeps its series, and the legend leaves it out. */}
              {TONES.map((tone) => (
                <Bar key={tone} dataKey={tone} stackId="sum" name={tone} fill={`var(--color-${tone})`} legendType={present.has(tone) ? 'rect' : 'none'} barSize={barSize} isAnimationActive={false} />
              ))}
              <Overlay steps={steps} changes={steps.map((_, index) => change(index))} barSize={barSize} mode={mode} compact={compact} connectors={render.connectors !== false} />
            </BarChart>
          </ChartContainer>
        )}
      />
      {/* A text alternative of the delivered steps, in delivered order, with the running total each leaves. */}
      <ValuesText caption={label} columns={table.columns} rows={table.rows.map((row, rowIndex) => row.map((value, column) => cellOf(value, column, rowIndex)))} />
    </div>
  );
}
