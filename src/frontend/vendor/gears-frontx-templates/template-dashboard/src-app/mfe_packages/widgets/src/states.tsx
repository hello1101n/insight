import { useEffect } from 'react';
import { Empty, EmptyHeader, EmptyTitle, Text, VisuallyHidden } from '@gears-frontx/ui-kit';

import styles from './widgets.module.css';
import type { Tone } from './types';

/** The widget's own wordings: English, whatever the host language (gears-frontx-templates#105). */
export interface WidgetTexts {
  empty: string;
  cannotBeShown: string;
  showData: string;
  showChart: string;
  dataOf: (title: string) => string;
  /** The accessible names of the grid's row colour meanings. */
  rowMeaning: Record<'success' | 'warning' | 'error' | 'info', string>;
  /** The accessible name of a chart or a grid when the cell gives none. */
  chart: string;
  table: string;
  /**
   * The column headings of a chart's text alternative and data view where the configuration names none: the series
   * of a scatter point, the x and y of a point when the axis has no label, and the label and value of a pie slice.
   */
  columns: Record<'series' | 'x' | 'y' | 'label' | 'value' | 'size', string>;
  /** The accessible names of the metric_card trend icon: an increase, a decrease, no change. */
  trend: Record<'up' | 'down' | 'flat', string>;
  /** The default headings of a ranked_list_card's two value columns, when the render names neither. */
  ranked: { value: string; secondary: string };
  /**
   * A progress_list_card bar: the word between its current and target value, the name of a goal when the render
   * gives none, and the note on a goal outside the bar, whose mark stands at the bar's nearer end.
   */
  progress: { of: string; goal: string; goalOutside: string };
  /**
   * A radial_progress ring: its accessible name, the word between its current and target value, the name of a goal
   * when the render gives none, the note on a current value above the target, and the note on a goal outside the
   * ring, whose tick stands at the ring's nearer end.
   */
  radial: { name: string; of: string; goal: string; overTarget: string; goalOutside: string };
  /** A metric_card reference: its name when the render gives none, and the accessible name of its difference. */
  metric: { reference: string; difference: (reference: string) => string };
  /** The pie_chart total, in the text alternative when the render gives no centre caption. */
  pie: { total: string };
  /**
   * A funnel_chart: the heading of the conversion column in its text alternative and data view, and the words after a
   * stage's conversion in its tooltip.
   */
  funnel: { conversion: string; ofPrevious: string };
  /** A radar_chart: the heading of the axis column in its text alternative and data view. */
  radar: { axis: string };
  /**
   * A treemap_chart: the headings of the group column and (with show_share) the share column in its text alternative
   * and data view, the name of the group the items without one go under, and the words after a tile's share in its
   * tooltip.
   */
  treemap: { group: string; share: string; other: string; ofTotal: string };
  /**
   * A waterfall_chart: the headings of the change and running total columns in its text alternative and data view,
   * and the names of its three bar tones in its legend, an increase, a decrease and a total.
   */
  waterfall: { change: string; running: string; increase: string; decrease: string; total: string };
  /**
   * An activity_feed: the accessible name of its list when the cell gives none, the Show more button that reveals the
   * next page of items, and the name of each shared tone an item's mark stands for, which the row writes in text so the
   * tone never rides on colour alone.
   */
  feed: { name: string; showMore: string; tone: Record<Tone, string> };
  /** The accessible note of a link that opens in a new tab. */
  link: { newTab: string };
  /**
   * The grid: the name of its search box, the text shown when a search keeps no row, and the text alternative of a
   * sparkline cell, which names its first, last, lowest and highest values, each already formatted.
   */
  grid: { search: string; noMatch: string; sparkline: (values: { first: string; last: string; min: string; max: string }) => string };
}

export const DEFAULT_WIDGET_TEXTS: WidgetTexts = {
  empty: 'No data to show',
  cannotBeShown: 'This widget cannot be shown',
  showData: 'Show data',
  showChart: 'Show chart',
  dataOf: (title) => `Data of ${title}`,
  rowMeaning: { success: 'Success', warning: 'Warning', error: 'Error', info: 'Info' },
  chart: 'Chart',
  table: 'Table',
  columns: { series: 'Series', x: 'x', y: 'y', label: 'Label', value: 'Value', size: 'Size' },
  trend: { up: 'Up', down: 'Down', flat: 'No change' },
  ranked: { value: 'Value', secondary: 'Secondary' },
  progress: { of: 'of', goal: 'Goal', goalOutside: 'outside the bar' },
  radial: { name: 'Progress', of: 'of', goal: 'Goal', overTarget: 'over the target', goalOutside: 'outside the ring' },
  metric: { reference: 'Reference', difference: (reference) => `Difference from ${reference}` },
  pie: { total: 'Total' },
  funnel: { conversion: 'Conversion', ofPrevious: 'of the previous stage' },
  radar: { axis: 'Axis' },
  treemap: { group: 'Group', share: 'Share', other: 'Other', ofTotal: 'of the total' },
  waterfall: { change: 'Change', running: 'Running total', increase: 'Increase', decrease: 'Decrease', total: 'Total' },
  feed: { name: 'Activity', showMore: 'Show more', tone: { neutral: 'Neutral', success: 'Success', warning: 'Warning', danger: 'Error', info: 'Info' } },
  link: { newTab: 'opens in a new tab' },
  grid: {
    search: 'Search the table',
    noMatch: 'No rows match the search',
    sparkline: ({ first, last, min, max }) => `First ${first}, last ${last}, lowest ${min}, highest ${max}`,
  },
};

/** The empty state every widget owns: valid data that meets its data type's empty condition. */
export function WidgetEmpty({ texts }: { texts: WidgetTexts }) {
  return (
    <Empty className={styles.fill}>
      <EmptyHeader>
        <EmptyTitle>{texts.empty}</EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

/** The widget's own cannot-be-shown state: static, with no error text. The problem goes to the console only. */
export function WidgetCannotBeShown({ texts, problem }: { texts: WidgetTexts; problem: string }) {
  useEffect(() => console.error(`[widget] ${problem}`), [problem]);
  return (
    <Text tone="muted" render={<p />} className={styles.cannot}>
      {texts.cannotBeShown}
    </Text>
  );
}

/** A text alternative of the values a widget shows only as graphics, for assistive technology. */
export function ValuesText({ caption, columns, rows }: { caption: string; columns: string[]; rows: string[][] }) {
  return (
    <VisuallyHidden>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, index) => (
                <td key={index}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </VisuallyHidden>
  );
}
