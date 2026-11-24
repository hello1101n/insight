import { Label, Pie, PieChart as RechartsPieChart } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, textOf, nonFiniteProblemOf } from '../format';
import { DEFAULT_WIDGET_TEXTS, ValuesText, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import type { PieData, PieRender } from '../types';
import { PALETTE, legendOf } from './legend';
import { ChartShell } from './ChartShell';
import { FILL } from './chrome';
import type { ValuesTable } from './DataView';
import { isCompact, isLaidOut, useElementSize } from './size';
import { CHAR_WIDTH, FLOOR_SIZE, HOLE_ROOM, LINE_HEIGHT } from '../textFit';
import styles from '../widgets.module.css';

/** The narrowest compact pie that keeps its legend beside it. */
const PIE_SIDE_LEGEND_WIDTH = 240;

/** A radius as Recharts takes it: a percentage stays a string, a pixel value becomes a number. */
const radiusOf = (value: string | undefined) => (value === undefined ? undefined : value.endsWith('px') ? Number.parseFloat(value) : value);

// @cpt-algo:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2
/** The pie's own check of its centre options: the problem, or null. */
export function checkPie(render: PieRender): string | null {
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-pie-center
  // A donut has a hole: two radius items, the inner one above 0 ("0%" or "0px" draws a full pie with no room for the total).
  const [inner, outer] = render.radius ?? [];
  const donut = outer !== undefined && Number.parseFloat(inner) > 0;
  if (render.center === 'total' && !donut) return 'pie_chart: center total needs a donut, a radius of two items';
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-pie-center
  // @cpt-begin:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-pie-center-label
  if (render.center_label !== undefined && render.center !== 'total') return 'pie_chart: center_label needs center total';
  // @cpt-end:cpt-frontx-dashboard-algo-widget-catalog-card-checks:p2:inst-wc-card-pie-center-label
  return null;
}

// The width of one character, the height of one line, the share of the hole's radius the centre text may reach and the
// readable floor are the shared ones of ../textFit: the centre text here fits its hole by the same numbers.
// The text sizes of the centre: the total at most as large as a card's headline, the caption as a meta line.
const TOTAL_SIZE = 24;
const CAPTION_SIZE = 12;

/**
 * The total in the hole of a donut, with its caption under it, each sized so the text block stays inside the hole: a
 * line that would fall under the smallest readable size is left out, and the text alternative still names the total.
 */
function CenterTotal({ cx, cy, innerRadius, total, caption }: { cx: number; cy: number; innerRadius: number; total: string; caption: string | undefined }) {
  const room = innerRadius * HOLE_ROOM;
  const fits = (width: number, height: number) => Math.hypot(width / 2, height / 2) <= room;
  const totalWidth = Math.max(total.length, 1) * CHAR_WIDTH;
  const totalSize = Math.min(TOTAL_SIZE, room / Math.hypot(totalWidth / 2, LINE_HEIGHT / 2));
  if (totalSize < FLOOR_SIZE) return null;
  const captionSize = caption ? Math.min(CAPTION_SIZE, totalSize) : 0;
  const withCaption =
    caption !== undefined && captionSize >= FLOOR_SIZE && fits(Math.max(totalWidth * totalSize, caption.length * CHAR_WIDTH * captionSize), (totalSize + captionSize) * LINE_HEIGHT);
  const shift = withCaption ? (captionSize * LINE_HEIGHT) / 2 : 0;
  return (
    <g className={styles.pieCenter}>
      <text x={cx} y={cy - shift} textAnchor="middle" dominantBaseline="central" fontSize={totalSize} className={styles.pieTotal}>
        {total}
      </text>
      {withCaption ? (
        <text x={cx} y={cy + (totalSize * LINE_HEIGHT) / 2} textAnchor="middle" dominantBaseline="central" fontSize={captionSize} className={styles.pieCaption}>
          {caption}
        </text>
      ) : null}
    </g>
  );
}

/** The `pie_chart` widget: the kit chart with one Recharts pie; two radius items make a donut. */
export function PieChart({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
  label: labelProp,
  container,
}: {
  payload: RenderWidgetPayload<PieRender, PieData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  const label = labelProp ?? texts.chart;
  const [measure, { width, height }] = useElementSize();
  if (!data) return <WidgetCannotBeShown texts={texts} problem="pie_chart: no data" />;
  const nonFinite = nonFiniteProblemOf('pie_chart', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  const problem = checkPie(render);
  if (problem) return <WidgetCannotBeShown texts={texts} problem={problem} />;
  if (data.slices.length === 0) return <WidgetEmpty texts={texts} />;

  const format = (value: string | number | null) => (typeof value === 'number' ? formatValue(value, value_format, locale) : (value ?? ''));
  // Every slice is in the legend with its label and value; a null or zero slice has no size but keeps its entry.
  const config: ChartConfig = Object.fromEntries(
    data.slices.map((slice, index) => [`p${index}`, { label: `${textOf(slice.label, undefined, locale)} ${format(slice.value)}`.trim(), color: PALETTE[index % PALETTE.length] }]),
  );
  // The total of the slices, nulls left out, for the hole of a donut and its row in the text alternative; a total beyond
  // the largest number (two slices of 1e308) is left out of both.
  const sum = data.slices.reduce((total, slice) => total + (slice.value ?? 0), 0);
  // Recharts sizes a slice by its share of the sum: when the sum overflows, the slices are drawn divided by the largest,
  // which keeps every share. The legend, the tooltip and the text alternative show the delivered values.
  const largest = data.slices.reduce((most, slice) => Math.max(most, Math.abs(slice.value ?? 0)), 0);
  const drawnOf = (value: number) => (Number.isFinite(sum) ? value : value / largest);
  // Each slice carries its own fill, the series colour the kit chart writes for its key.
  const rows = data.slices.map((slice, index) => ({ key: `p${index}`, value: drawnOf(slice.value ?? 0), fill: `var(--color-p${index})` }));
  const table: ValuesTable = { columns: [texts.columns.label, texts.columns.value], rows: data.slices.map((slice) => [slice.label, slice.value]) };
  const [first, second] = render.radius ?? [];
  const inner = second === undefined ? 0 : radiusOf(first);
  const outer = radiusOf(second ?? first) ?? '80%';
  // A legend above or below a pie in a low cell leaves the pie a dot: there it moves beside the pie, and where
  // the cell is narrow too it is left out (the tooltip and the text alternative still name every slice).
  const asked = render.legend_position ?? 'bottom';
  const narrow = width > 0 && width < PIE_SIDE_LEGEND_WIDTH;
  const total = render.center === 'total' && Number.isFinite(sum) ? format(sum) : null;
  const totalRow = total === null ? [] : [[render.center_label ?? texts.pie.total, total]];
  const legend = !isCompact(height) || asked === 'none' ? asked : narrow ? 'none' : asked === 'top' || asked === 'bottom' ? 'right' : asked;

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
            <RechartsPieChart>
              {/* The config label already carries the slice's formatted value, so the tooltip shows the label alone. */}
              <ChartTooltip content={<ChartTooltipContent nameKey="key" hideLabel formatter={(_value, key) => <span>{String(config[String(key)]?.label ?? '')}</span>} />} />
              <Pie data={rows} dataKey="value" nameKey="key" innerRadius={inner} outerRadius={outer} isAnimationActive={false} onClick={onPick ? (_entry: unknown, index: number) => onPick(index) : undefined}>
                {total === null ? null : (
                  <Label
                    position="center"
                    content={({ viewBox }) => {
                      // Recharts hands a label in a pie the plot box: the pie stands in its middle, a percent radius is a share of half its shorter side.
                      const box = viewBox as { x?: number; y?: number; width?: number; height?: number } | undefined;
                      if (box?.x === undefined || box.y === undefined || !box.width || !box.height) return null;
                      const hole = typeof inner === 'number' ? inner : (Number.parseFloat(inner ?? '0') / 100) * (Math.min(box.width, box.height) / 2);
                      return <CenterTotal cx={box.x + box.width / 2} cy={box.y + box.height / 2} innerRadius={hole} total={total} caption={render.center_label} />;
                    }}
                  />
                )}
              </Pie>
              {legendOf(legend, 'key')}
            </RechartsPieChart>
          </ChartContainer>
        )}
      />
      <ValuesText caption={label} columns={table.columns} rows={[...table.rows.map(([name, value]) => [textOf(name, undefined, locale), format(value)]), ...totalRow]} />
    </div>
  );
}
