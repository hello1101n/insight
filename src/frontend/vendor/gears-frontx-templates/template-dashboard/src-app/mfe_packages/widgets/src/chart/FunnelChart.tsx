import type { CSSProperties } from 'react';
import { Text } from '@gears-frontx/ui-kit';
import type { RenderWidgetPayload } from '@gears-frontx/frontx-dashboard-root/contract';

import { formatValue, nonFiniteProblemOf, percentInRange } from '../format';
import { DEFAULT_WIDGET_TEXTS, ValuesText, WidgetCannotBeShown, WidgetEmpty, type WidgetTexts } from '../states';
import type { FunnelData, FunnelRender } from '../types';
import { ChartShell } from './ChartShell';
import type { ValuesTable } from './DataView';
import { isCompact, useElementSize } from './size';
import { estimateWidth } from '../textFit';
import styles from '../widgets.module.css';

// The one fill of every stage: the first colour of the chart palette, as the radial ring and the first series take it.
const FILL = 'var(--chart-5)';
// The gap between two stages (the `.funnel` gap in widgets.module.css).
const STAGE_GAP = 4;
// The text line's height.
const LINE = 16;
// The text line's gap to the bar (the `.funnelStage` gap in widgets.module.css).
const LINE_GAP = 2;
// The share of the width a beside line takes (the `.funnelBeside > .funnelLine` 40% in widgets.module.css).
const BESIDE_SHARE = 0.4;
// A bar is never taller than the kit's small control height (--control-height-sm, 2rem = 32 px), so a few stages in a
// high cell stay bars and the rest of the cell stays empty, and never lower than the kit's --space-2 (0.5rem = 8 px),
// so a bar in a low cell stays visible. Px here because the layout ladder below compares them with measured heights.
const BAR_CEILING = 32;
const BAR_FLOOR = 8;
// The least stage height for the line over a floor-high bar (26 px), and for the line beside the bar (16 px).
const OVER_STAGE = LINE + LINE_GAP + BAR_FLOOR;
const BESIDE_STAGE = Math.max(LINE, BAR_FLOOR);

/**
 * Where a stage's text line goes and how high its bar is, from the list's measured height and the number of stages.
 * Over the bar while the line and a floor-high bar fit (26 px a stage), beside it while the line fits (16 px; the line
 * takes the stage's first BESIDE_SHARE of width), and below that nowhere: the stage draws its bar alone. The bar takes
 * what is left of the stage, between BAR_FLOOR and BAR_CEILING. Where even floor-high bars do not fit (12 stages in a
 * very low cell) the list scrolls inside the widget's body. Before the first measurement every stage keeps its line.
 */
function funnelLayout(listHeight: number, count: number): { textAt: 'over' | 'beside' | null; bar: number } {
  const stage = listHeight > 0 ? (listHeight - STAGE_GAP * (count - 1)) / count : Infinity;
  const bar = (room: number) => Math.min(BAR_CEILING, Math.max(BAR_FLOOR, room));
  if (stage >= OVER_STAGE) return { textAt: 'over', bar: bar(stage - LINE - LINE_GAP) };
  if (stage >= BESIDE_STAGE) return { textAt: 'beside', bar: bar(stage) };
  return { textAt: null, bar: bar(stage) };
}
// The font size the width estimate (`estimateWidth`) counts with: the label, the value and the conversion are all 12 px.
const TEXT_PX = 12;
// The gap between the parts of the line (the `.funnelLine` gap, var(--space-2), in widgets.module.css).
const PART_GAP = 8;
// The least of a label kept beside a conversion: about four characters by CHAR_WIDTH (2.5 em) plus the ellipsis, 3 em in
// all. A stage without a readable name says less than a stage without its conversion, so the conversion yields first.
const LABEL_MIN_EM = 3;
const HYPHEN = '-';

/** The funnel's own check of its data: the first stage with a negative value, by its position, or null. */
export function checkFunnel(data: FunnelData): string | null {
  const index = data.stages.findIndex((stage) => stage.value !== null && stage.value < 0);
  return index < 0 ? null : `funnel_chart: data.stages[${index}].value is below 0`;
}

/**
 * The conversion of each stage, its value over the previous stage's value: undefined for the first stage, which has
 * none, and null where there is no share to show (either value null, or a previous value of 0).
 */
function conversionsOf(stages: FunnelData['stages']): Array<number | null | undefined> {
  return stages.map((stage, index) => {
    if (index === 0) return undefined;
    const previous = stages[index - 1].value;
    return stage.value === null || previous === null || previous === 0 ? null : (stage.value || 0) / previous;
  });
}

/**
 * The `funnel_chart` widget: one stage per row, in delivered order, each a bar centred in its row and as wide as its
 * value over the largest value, so a stage larger than the one before is drawn wider. Over the bar, a text line
 * names the stage, its value (by `value_labels`) and its share of the previous stage (by `show_conversion`); where the
 * line is narrow the label comes first, then the conversion, then the auto value. A null
 * value draws an empty stage with a hyphen. The text alternative and the data view list every stage with its value
 * and conversion.
 */
export function FunnelChart({
  payload,
  locale = 'en',
  texts = DEFAULT_WIDGET_TEXTS,
  label: labelProp,
  container,
}: {
  payload: RenderWidgetPayload<FunnelRender, FunnelData>;
  locale?: string;
  texts?: WidgetTexts;
  label?: string;
  container?: HTMLElement | ShadowRoot | null;
}) {
  const { render, data, value_format } = payload;
  const label = labelProp ?? texts.chart;
  const [measure, { height }] = useElementSize();
  // The stages share the list's own box, which leaves out the data view button of a chart with drill-down.
  const [measureList, list] = useElementSize<HTMLOListElement>();
  if (!data) return <WidgetCannotBeShown texts={texts} problem="funnel_chart: no data" />;
  const nonFinite = nonFiniteProblemOf('funnel_chart', payload);
  if (nonFinite) return <WidgetCannotBeShown texts={texts} problem={nonFinite} />;
  const problem = checkFunnel(data);
  if (problem) return <WidgetCannotBeShown texts={texts} problem={problem} />;
  const { stages } = data;
  const largest = stages.reduce((most, stage) => Math.max(most, stage.value ?? 0), 0);
  if (!(largest > 0)) return <WidgetEmpty texts={texts} />;

  const showConversion = render.show_conversion !== false;
  const valueLabels = render.value_labels ?? 'auto';
  const conversions = conversionsOf(stages);
  const valueOf = (value: number | null) => (value === null ? HYPHEN : formatValue(value || 0, value_format, locale));
  // A share beyond the largest number is no share to show either: formatValue leaves it empty.
  const conversionOf = (share: number | null | undefined) => (share === undefined ? '' : (share !== null && formatValue(share, { value_type: 'percent' }, locale)) || HYPHEN);

  const compact = isCompact(height);
  const { textAt, bar } = funnelLayout(list.height, stages.length);
  const room = list.width > 0 ? list.width * (textAt === 'beside' ? BESIDE_SHARE : 1) : Infinity;
  const widthOf = (text: string, px: number) => (text === '' ? 0 : estimateWidth(text, px) + PART_GAP);

  const columns = [texts.columns.label, texts.columns.value, ...(showConversion ? [texts.funnel.conversion] : [])];
  const table: ValuesTable = { columns, rows: stages.map((stage, index) => [stage.label, stage.value, ...(showConversion ? [conversions[index] ?? null] : [])]) };
  const format = (value: string | number | null, column: number, row: number) => {
    if (column === 0) return String(value ?? '');
    if (column === 1) return valueOf(typeof value === 'number' ? value : null);
    return conversionOf(conversions[row]);
  };

  return (
    <div ref={measure} className={styles.fill} role="figure" aria-label={label}>
      <ChartShell
        drillDown={render.drill_down === true}
        table={table}
        label={texts.dataOf(label)}
        texts={texts}
        format={format}
        locale={locale}
        container={container}
        draw={(onPick) => (
          <ol ref={measureList} className={styles.funnel} aria-hidden>
            {stages.map((stage, index) => {
              const value = stage.value === null ? '' : valueOf(stage.value);
              const conversion = showConversion ? conversionOf(conversions[index]) : '';
              // auto: the value shows when the label, the value and the conversion fit the stage's width together, never in a low cell.
              const fits = widthOf(stage.label, TEXT_PX) + widthOf(value, TEXT_PX) + widthOf(conversion, TEXT_PX) - PART_GAP <= room;
              const shownValue = valueLabels === 'always' || (valueLabels === 'auto' && !compact && fits) ? value : '';
              // The conversion shows while the label keeps its least readable width beside it and the value shown.
              const labelLeast = Math.min(widthOf(stage.label, TEXT_PX), LABEL_MIN_EM * TEXT_PX + PART_GAP);
              const shownConversion = labelLeast + widthOf(shownValue, TEXT_PX) + widthOf(conversion, TEXT_PX) - PART_GAP <= room ? conversion : '';
              const share = stage.value === null ? null : percentInRange((stage.value || 0) / largest);
              const tooltip = [`${stage.label}: ${valueOf(stage.value)}`, conversion && conversion !== HYPHEN ? `${conversion} ${texts.funnel.ofPrevious}` : ''].filter(Boolean).join(', ');
              return (
                <li key={index} className={[styles.funnelStage, textAt === 'beside' ? styles.funnelBeside : '', onPick ? styles.funnelPick : ''].filter(Boolean).join(' ')} title={tooltip} data-stage={index} onClick={onPick ? () => onPick(index) : undefined}>
                  {textAt ? (
                    <div className={styles.funnelLine}>
                      <Text typography="label" render={<span />} className={styles.funnelLabel}>
                        {stage.label}
                      </Text>
                      {shownValue ? (
                        <Text typography="meta" render={<span />} className={styles.funnelValue} data-part="value">
                          {shownValue}
                        </Text>
                      ) : null}
                      {shownConversion ? (
                        <Text typography="meta" tone="muted" render={<span />} className={styles.funnelValue} data-part="conversion">
                          {shownConversion}
                        </Text>
                      ) : null}
                    </div>
                  ) : null}
                  <div className={styles.funnelTrack} style={{ blockSize: bar }}>
                    {share === null ? (
                      <Text typography="meta" tone="muted" render={<span />} data-part="empty">
                        {HYPHEN}
                      </Text>
                    ) : (
                      <span className={styles.funnelBar} data-share={share} style={{ inlineSize: `${share}%`, minInlineSize: stage.value !== null && stage.value > 0 ? 2 : 0, background: FILL } as CSSProperties} />
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      />
      <ValuesText caption={label} columns={columns} rows={table.rows.map((row, rowIndex) => row.map((value, column) => format(value, column, rowIndex)))} />
    </div>
  );
}
