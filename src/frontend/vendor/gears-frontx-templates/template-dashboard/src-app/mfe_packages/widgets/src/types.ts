/*
 * The render options and data shapes of the catalog widget types this package
 * draws, as the widget catalog FEATURE declares them. The widget type and data
 * type schemas there are normative; these types mirror them.
 */

import type { ValueFormat } from '@gears-frontx/frontx-dashboard-root/contract';

export interface CartesianSeriesOption {
  name: string;
  type: 'bar' | 'line' | 'area' | 'scatter';
  y_axis?: 'primary' | 'secondary';
  stack_group?: string;
  /** A line or area only: a name written at the end of the series, such as a target. */
  label?: string;
  /** A line or area only. */
  line_style?: 'solid' | 'dashed';
  /** A line or area only: a mark with its value on the lowest and/or highest delivered point; on ties, the first point in axis order. */
  mark_extremes?: 'min' | 'max' | 'both';
}

/** A line across the plot at a value: on a value axis a number, on a category x axis a category. */
export interface ReferenceLineOption {
  axis?: 'y' | 'y_secondary' | 'x';
  value: number | string;
  label?: string;
  line_style?: 'dashed' | 'solid';
}

export type LegendPosition = 'top' | 'right' | 'bottom' | 'left' | 'none';

export interface CartesianRender {
  series?: CartesianSeriesOption[];
  /** The stack group of each data series without an entry in `series`: such a series draws as bars on the primary axis, stacked in this group. */
  unlisted_stack_group?: string;
  x_axis?: {
    type?: 'category' | 'value' | 'time';
    label?: string;
    /**
     * `auto` skips labels that would collide; `every` labels every category, thinning out only when they cannot fit. On a
     * category axis either first cuts a level label longer than its room with an ellipsis.
     */
    tick_labels?: 'auto' | 'every';
    tick_angle?: 0 | -45 | -90;
  };
  y_axis?: { type?: 'value' | 'log'; label?: string };
  y_axis_secondary?: { type?: 'value' | 'log'; label?: string; unit?: string };
  legend_position?: LegendPosition;
  /** Values written at the bars' ends (below a bar that grows down): `auto` when every bar is wide enough. */
  value_labels?: 'auto' | 'always' | 'never';
  /** Marks open the data view with the picked row expanded, and a button opens the whole data view. */
  drill_down?: boolean;
  /** `horizontal` puts the categories on the vertical axis and the values on the horizontal one; a category x axis only. */
  orientation?: 'vertical' | 'horizontal';
  /** `percent` draws each stack group as shares of 100% at each x. */
  stack_mode?: 'absolute' | 'percent';
  /** The name of a scatter point's size, in the tooltip and the data view. */
  size_label?: string;
  reference_lines?: ReferenceLineOption[];
}

export interface CartesianPoint {
  x: string | number | null;
  y: number | null;
  /** A scatter point only: its size; the point's area grows in proportion to it. */
  size?: number | null;
}

export interface CartesianData {
  series: { name: string | null; points: CartesianPoint[] }[];
}

export interface PieRender {
  /** Outer radius, or inner and outer radius, each `<n>%` or `<n>px`. Two items make a donut. */
  radius?: string[];
  legend_position?: LegendPosition;
  drill_down?: boolean;
  /** `total` writes the sum of the slice values in the middle of a donut; a donut only. */
  center?: 'none' | 'total';
  /** A short caption under the total; with `center: total` only. */
  center_label?: string;
}

export interface PieData {
  slices: { label: string | number | null; value: number | null }[];
}

export interface GridColumn {
  key: string;
  title?: string;
  /** Width in pixels; the table is at least the sum of the widths (a floor for a column without one) and scrolls sideways in a narrower cell. */
  width?: number;
  format?: { notation?: 'standard' | 'compact' };
  /** The format of the column's numbers, in place of the widget's `value_format`; a progress column takes none. */
  value_format?: ValueFormat;
  align?: 'start' | 'end' | 'center';
  sortable?: boolean;
  /** `truncate` keeps one line per cell; the full text stays in the cell's title. */
  overflow?: 'wrap' | 'truncate';
  /**
   * How a cell draws its value: `text` (the default) as text; `badge` a string as a badge toned by `tones`; `progress`
   * a number from 0 to 1 as a bar with its percent; `sparkline` a list of numbers or nulls as a small line.
   */
  kind?: 'text' | 'badge' | 'progress' | 'sparkline';
  /** A badge column only: the tone of each value; a value with no tone draws neutral. */
  tones?: Tones;
}

export interface GridRender {
  columns: GridColumn[];
  page_sizes?: number[];
  frozen_columns?: number;
  column_groups?: { title: string; members: string[] }[];
  row_color?: string;
  /** A search box above the grid that keeps the rows whose shown text contains the query, in any column. */
  search?: boolean;
}

/** A grid value drawn as a link through the shared link rule of the widgets. */
export interface GridLink {
  text: string;
  href: string;
}

/** A grid value: text, a number, a link, or, in a sparkline column only, a list of at most 60 numbers or nulls. */
export type GridValue = string | number | null | GridLink | (number | null)[];

export interface GridData {
  rows: GridValue[][];
  /** The row count of the full result when `rows` holds only its first rows; not below the number of rows. */
  total_rows?: number | null;
}

/** A link a card draws: its text, and its target, which the shared link helper checks before it links. */
export interface WidgetLink {
  text: string;
  href: string;
}

/** The tone a status value is drawn in. */
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

/** The tones type: a status value to its tone; a status with no tone draws neutral. */
export type Tones = Record<string, Tone>;

/** The `metric_card` render: an optional caption of the headline value; without it, no caption shows. */
export interface MetricCardRender {
  value_label?: string;
  /** The direction of an improvement, for the trend's colour: `higher` when absent; `neutral` paints no change as better or worse. */
  better?: 'higher' | 'lower' | 'neutral';
  /** What `reference_value` is, such as last week. */
  reference_label?: string;
  /** A link at the card's foot. */
  link?: WidgetLink;
}

export interface MetricCardData {
  /** The headline. Null is the data type's empty condition. */
  value: number | null;
  /**
   * The value the trend compares with. Absent or null shows no trend; 0 shows
   * the direction icon alone, without a change.
   */
  previous_value?: number | null;
  /** One point per step; a null point is a gap. */
  sparkline?: (number | null)[];
  /** A value to compare with, shown under the headline with the difference. Absent or null shows none. */
  reference_value?: number | null;
}

/** The `summary_card` render: the type closes an empty render, so it carries nothing. */
export type SummaryCardRender = Record<string, never>;

/** The `summary_card` data: one row per line, in delivered order. */
export interface SummaryCardData {
  rows: { label: string | null; value: number | null }[];
}

/** The `ranked_list_card` render: optional headings of the two value columns; the defaults stand in where they are absent. */
export interface RankedListCardRender {
  value_label?: string;
  secondary_label?: string;
  /** The tone of each row status. */
  status_tones?: Tones;
}

export interface RankedListCardData {
  /** Rows in the delivered order: the rank is the position, and the widget never re-ranks or re-orders them. */
  rows: {
    label: string | number | null;
    value: number | null;
    /** Omitted when the data has no secondary value; a null one shows as an empty value. */
    secondary?: number | null;
    /** A status badge on the row, toned by `status_tones`. */
    status?: string | null;
    /** The row's label becomes a link to it. */
    href?: string | null;
  }[];
}

/** The `heatmap` render: the axis titles, the ends of the colour scale, and whether the cells show their values. */
export interface HeatmapRender {
  x_axis_label?: string;
  y_axis_label?: string;
  /** The lower end of the colour scale; null or absent takes the lowest value in the rows. */
  min_value?: number | null;
  /** The upper end of the colour scale; null or absent takes the highest value in the rows. */
  max_value?: number | null;
  /** Whether to show each cell's value inside the cell. */
  show_cell_values?: boolean;
  /** `matrix` (the default) draws x by y categories; `calendar` draws one tile per day, weeks by weekdays. */
  mode?: 'matrix' | 'calendar';
  /** Calendar mode only: the weekday each week column starts on; Monday when absent. */
  week_start?: 'monday' | 'sunday';
  /** Tiles open the data view with the picked row expanded, and a button opens the whole data view. */
  drill_down?: boolean;
}

export interface HeatmapData {
  /**
   * One row per cell value, in delivered order; the x and y categories keep the order of their first appearance.
   * In calendar mode x is a `YYYY-MM-DD` date and y is omitted or null; in matrix mode an omitted y counts as null.
   */
  rows: { x: string | number | null; y?: string | number | null; value: number | null }[];
}

/** The `markdown_card` render: the CommonMark body to show, with embedded HTML as text. It carries no data. */
export interface MarkdownCardRender {
  body: string;
}

/** The `progress_list_card` render. */
export interface ProgressListCardRender {
  /** The name of a row goal in the text alternative and the tooltip. */
  goal_label?: string;
}

export interface ProgressListCardData {
  /** Rows in the delivered order: the bar fills by `current` over `target`. */
  rows: {
    label: string | number | null;
    current: number | null;
    target: number | null;
    /** A goal mark on the bar. */
    goal?: number | null;
  }[];
}

/** The `radial_progress` render. */
export interface RadialProgressRender {
  /** What the centre shows: the percent of the target, the current value, or both. Without it, `percent`. */
  display?: 'percent' | 'value' | 'both';
  /** A short caption under the centre number. */
  center_label?: string;
  /** The name of the goal in the text alternative and the tooltip. */
  goal_label?: string;
}

export interface RadialProgressData {
  /** The ring fills by `current` over `target`. */
  current: number | null;
  target: number | null;
  /** A goal tick on the ring. */
  goal?: number | null;
}

/** The `funnel_chart` render. */
export interface FunnelRender {
  /** Each stage after the first shows its share of the previous stage as a percent. Without it, true. */
  show_conversion?: boolean;
  /** `auto` shows a stage's value when it fits the stage's width with its label and conversion, never in a low cell. */
  value_labels?: 'auto' | 'always' | 'never';
  /** Stages open the data view with the picked row expanded, and a button opens the whole data view. */
  drill_down?: boolean;
}

export interface FunnelData {
  /** One to twelve stages in the delivered order; a null value draws an empty stage. */
  stages: { label: string; value: number | null }[];
}

/** The `radar_chart` render. */
export interface RadarRender {
  /** The top of the value axis at least: a larger value extends it to that value. Without it, the largest value rounded up by the axis tick rule. */
  scale_max?: number;
  /** The series draw their area at a low opacity in their tone. Without it, true. */
  fill?: boolean;
  legend_position?: LegendPosition;
  /** Spokes open the data view with the picked row expanded, and a button opens the whole data view. */
  drill_down?: boolean;
}

export interface RadarData {
  /**
   * The values of the spokes in the long format of the cartesian chart: one point per series value, 3 to 120 of
   * them. The axes keep their first-seen order (3 to 12 of them), and so do the series (1 to 5, one per palette tone); a null series is
   * the one unnamed series, and a null value is a gap on that axis.
   */
  points: { axis: string; series: string | null; value: number | null }[];
}

/** The `treemap_chart` render. */
export interface TreemapRender {
  /**
   * Where a tile writes its value: `auto` when the label and it fit the tile, estimated from their lengths,
   * the label alone when only it fits, nothing below that; `always` whatever the tile fits; `never` nowhere.
   * Without it, auto.
   */
  value_labels?: 'auto' | 'always' | 'never';
  /** The value as a share of the total beside its value in the tile, in its tooltip, the text alternative and the data view. Without it, false. */
  show_share?: boolean;
  /** Tiles open the data view with the picked row expanded, and a button opens the whole data view. */
  drill_down?: boolean;
}

export interface TreemapData {
  /**
   * One to 60 items in the delivered order. When any item names a group, the items are nested one level by group
   * in first-seen order, and a null group goes under the widget's "Other" group. A null or 0 value draws no tile
   * and stays in the data view.
   */
  items: { label: string; value: number | null; group: string | null }[];
}

/** The `waterfall_chart` render. */
export interface WaterfallRender {
  /** A thin line from one bar's end to the next bar's start. Without it, true. */
  connectors?: boolean;
  /**
   * Where a bar writes its change over its top edge, a delta's signed and a total's bare: `auto` when it fits the
   * band the bar stands in, estimated from its length, and never in a low cell; `always` whatever the band fits;
   * `never` nowhere. Without it, auto.
   */
  value_labels?: 'auto' | 'always' | 'never';
  /** Bars open the data view with the picked row expanded, and a button opens the whole data view. */
  drill_down?: boolean;
}

export interface WaterfallData {
  /**
   * Two to 24 steps in the delivered order, of the running sum the chart starts at 0, unless the first step is
   * a total: that total is the start of the sum, the value it begins at. A delta moves the running sum
   * by its value (a negative one down); a null delta draws nothing and leaves the sum unchanged. A total draws the
   * running sum from 0, its own value staying null or the running sum itself (the widget cross-checks the two).
   * A running sum that leaves the finite range fails the cell, naming the step that moved it.
   */
  steps: { label: string; value: number | null; kind?: 'delta' | 'total' }[];
}

export interface ActivityFeedRender {
  /**
   * How an item writes its time: `relative` from the host clock (its locale's relative wording, such as "3 days
   * ago"), `absolute` as the host locale writes the date (and, for a date-time, its time of day). Without it, relative.
   */
  time_style?: 'relative' | 'absolute';
  /**
   * How many items the feed shows before its Show more button: 3 to 50. Without it, 10.
   */
  page_size?: number;
  /** Whether an item of a tone carries its mark beside the title. Without it, true. */
  show_tone?: boolean;
}

export interface ActivityFeedData {
  /**
   * 0 to 200 items in the delivered order, which the feed keeps. Each item needs a time (an ISO 8601 date-time or a
   * bare `YYYY-MM-DD` date, the one date rule) and a title of 1 to 120 characters, and may carry a text of up to 400
   * characters, a tone of the shared tones, and a link target (the shared link rule). A time that is no such date
   * fails the cell, naming the item by its position.
   */
  items: { time: string; title: string; text?: string; tone?: Tone; href?: string }[];
}
