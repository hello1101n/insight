import {
  DASHBOARD_TYPE_ID,
  DATA_WIDGET_TYPE_ID,
  WIDGET_BASE_TYPE_ID,
  uuidv5,
} from "@gears-frontx/frontx-dashboard-root";
import type {
  Dashboard as FrontxDashboard,
  DashboardCell,
  DashboardRequest,
  ServedFile,
  WidgetInstance,
} from "@gears-frontx/frontx-dashboard-root/contract";
import catalog from "@gears-frontx/frontx-dashboard-root/served/catalog.gts.json";

import {
  dashboardWidgetPath,
  type DashboardItem,
  type DashboardRead,
  type DashboardWidget,
  type MetricResult,
  type Target,
  type Widget,
} from "@/api/custom-client";
import { dashboardItems } from "@/lib/custom/dashboard-items";
import { drawsBucket } from "@/lib/custom/draws-bucket";
import { dailyBuckets } from "@/lib/custom/time-range";

export interface FrontxBoard {
  dashboardId: string;
  file: ServedFile;
  runs: ReadonlyMap<string, { dashboard: string; widget: DashboardWidget }>;
  widgets: ReadonlyMap<string, DashboardWidget>;
}

export interface FrontxAnswer extends MetricResult {
  at: Record<string, number>;
  distinct: Record<string, unknown[]>;
  shownRows: unknown[][];
  previous?: FrontxAnswer | null;
}

// INVARIANT: FrontX grid data holds at most 500 rows, and a longer list fails the cell.
const TABLE_ROWS = 500;

// INVARIANT: FrontX treemap data holds 1 to 60 items, labels of 1 to 80 characters and groups of 1 to 40.
const TREEMAP_ITEMS = 60;
const TREEMAP_LABEL = 80;
const TREEMAP_GROUP = 40;

// INVARIANT: a FrontX funnel stage label holds 1 to 80 characters.
const FUNNEL_LABEL = 80;

const NO_NAME = "—";

const NAMESPACE = uuidv5("insight.custom.dashboards");

const cel = JSON.stringify;

const column = (name: string) => `int(response.at[${cel(name)}])`;

// WORKAROUND: a value_format fixes its decimals, and the current stat shows at most one decimal
// from 10 up and two below. CEL has no round.
const rounded = (value: string) =>
  `cel.bind(n, ${value}, cel.bind(k, n >= 10.0 || n <= -10.0 ? 10.0 : 100.0, double(int(n * k + (n < 0.0 ? -0.5 : 0.5))) / k))`;

// WORKAROUND: CEL types both ternary branches alike, so a nullable number goes through dyn.
// INVARIANT: an Insight percent column holds 0 to 100, and a FrontX percent format reads a fraction.
const number = (row: string, at: string, percent = false, round = false) => {
  const value = `double(${row}[${at}])`;
  return `(${row}[${at}] == null ? dyn(null) : dyn(${round ? rounded(value) : value}${percent ? " / 100.0" : ""}))`;
};

const PERCENT = { value_type: "percent" } as const;

const PREVIOUS_PERIOD = "Previous period";

const PERCENT_COLUMN = { value_type: "percent", decimals: 1 } as const;

// WORKAROUND: a FrontX grid column with no width takes 160 px, so a table of a few short columns scrolls sideways.
// INVARIANT: the kit table header takes at most 7 px a letter, 32 px of padding and 16 px for the sort mark.
const columnWidth = (title: string) => 7 * title.length + 48;

const DATE = cel(String.raw`^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])`);

const MONTHS = cel(
  "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")
);

const isDate = (value: string) =>
  `(type(${value}) == string && ${value}.matches(${DATE}))`;

const spansYears = `cel.bind(ys, response.rows.filter(r, ${isDate("r[x]")}).map(r, r[x].substring(0, 4)), ys.exists(yr, yr != ys[0]))`;

// WORKAROUND: a FrontX category axis writes a date as it arrives, and the current chart writes `Nov 3`.
// INVARIANT: the transform binds `w` to whether the x column spans more than one year.
const shortDate = (value: string) =>
  `(${isDate(value)} ? dyn(${MONTHS}[int(${value}.substring(5, 7)) - 1] + ' ' + string(int(${value}.substring(8, 10))) + (w ? ', ' + ${value}.substring(0, 4) : '')) : ${value})`;

function dataWidgetId(type: string, key: string): string {
  return `${DATA_WIDGET_TYPE_ID}frontx.dashboard.widget.${type}.v1~${uuidv5(key, NAMESPACE)}`;
}

function markdownId(key: string): string {
  return `${WIDGET_BASE_TYPE_ID}frontx.dashboard.widget.markdown_card.v1~${uuidv5(key, NAMESPACE)}`;
}

const runPath = (dashboard: string, widget: string) =>
  `${dashboardWidgetPath(dashboard, widget)}/run`;

function runRequest(
  dashboard: string,
  widget: DashboardWidget,
  windowed: boolean
): DashboardRequest {
  const path = runPath(dashboard, widget.id);
  if (!windowed || !widget.clock) return { method: "POST", path };

  return {
    method: "POST",
    path,
    body: { bucket: drawsBucket(widget.body) },
    variables: { range: "range" },
  };
}

interface Drawn {
  type: string;
  render: Record<string, unknown>;
  transform: string;
  value_format?: WidgetInstance["value_format"];
}

interface Note {
  note: string;
}

// INVARIANT: no chart sets drill_down. With it, FrontX draws a "Show data" row inside the cell under the frame's own actions.
function chart(
  x: string,
  y: string,
  percent: boolean,
  render: Record<string, unknown>,
  series: (point: string, value: string) => string
): Drawn {
  const point = `{'x': ${shortDate("r[x]")}, 'y': ${number("r", "y", percent)}}`;

  return {
    ...(percent ? { value_format: PERCENT } : {}),
    type: "cartesian_chart",
    render: {
      ...render,
      x_axis: { type: "category" },
      y_axis: { type: "value" },
    },
    transform: `cel.bind(x, ${column(x)}, cel.bind(w, ${spansYears}, cel.bind(y, ${column(y)}, {'series': ${series(point, cel(y))}})))`,
  };
}

function oneSeries(
  widget: { x: string; y: string },
  kind: string,
  percent: boolean,
  render: Record<string, unknown> = {}
): Drawn {
  return chart(
    widget.x,
    widget.y,
    percent,
    {
      ...render,
      series: [{ name: widget.y, type: kind }],
      legend_position: "none",
    },
    (point, name) =>
      `[{'name': ${name}, 'points': response.rows.map(r, ${point})}]`
  );
}

// WORKAROUND: a FrontX series that the render does not name draws as bars, and only the data names a series value.
function seriesPerValue(
  widget: Widget & { x: string; y: string; series: string },
  percent: boolean,
  stacked: boolean,
  render: Record<string, unknown> = {}
): Drawn {
  const values = `response.distinct[${cel(widget.series)}]`;
  const name = `(v == null ? dyn(null) : dyn(string(v)))`;

  return chart(
    widget.x,
    widget.y,
    percent,
    {
      ...render,
      legend_position: "bottom",
      ...(stacked ? { unlisted_stack_group: widget.series } : {}),
    },
    (point) =>
      `cel.bind(s, ${column(widget.series)}, ${values}.map(v, {'name': ${name}, 'points': response.rows.filter(r, r[s] == v).map(r, ${point})}))`
  );
}

// INVARIANT: a target value is in the units a reader sees, and a FrontX percent axis reads a fraction.
function targetLines(
  target: Target | undefined,
  fraction: boolean
): Record<string, unknown> {
  if (!target) return {};

  const value = fraction ? target.value / 100 : target.value;
  return {
    reference_lines: [
      { value, ...(target.label ? { label: target.label } : {}) },
    ],
  };
}

// INVARIANT: the host adds `previous` only to the answer of a compared stat over a bounded range.
function previousFigure(value: string, percent: boolean): string {
  const previous = "response.previous";
  const figure = number(`${previous}.rows[0]`, "p", percent, true);

  return `(!has(${previous}) || ${previous} == null || size(${previous}.rows) == 0 ? dyn(null) : cel.bind(p, int(${previous}.at[${cel(value)}]), ${figure}))`;
}

const clipped = (text: string, most: number) =>
  `(size(${text}) > ${most} ? ${text}.substring(0, ${most - 1}) + '…' : ${text})`;

// INVARIANT: FrontX refuses an empty or too long treemap name, so a blank name is the dash and a long one ends in an ellipsis.
function treemapName(value: string, most: number, blank: string): string {
  return `(${value} == null || string(${value}) == '' ? ${blank} : dyn(${clipped(`string(${value})`, most)}))`;
}

function heatmap(
  widget: Widget & { type: "heatmap" },
  percent: boolean,
  daily: boolean
): Drawn {
  const format = percent ? { value_format: PERCENT } : {};
  const value = number("r", "v", percent);

  if (widget.y !== undefined) {
    return {
      ...format,
      type: "heatmap",
      render: {},
      transform: `cel.bind(x, ${column(widget.x)}, cel.bind(w, ${spansYears}, cel.bind(y, ${column(widget.y)}, cel.bind(v, ${column(widget.value)}, {'rows': response.rows.map(r, {'x': ${shortDate("r[x]")}, 'y': r[y], 'value': ${value}})}))))`,
    };
  }
  if (!daily) {
    return oneSeries({ x: widget.x, y: widget.value }, "bar", percent, {
      value_labels: "never",
    });
  }

  return {
    ...format,
    type: "heatmap",
    render: { mode: "calendar" },
    transform: `cel.bind(x, ${column(widget.x)}, cel.bind(v, ${column(widget.value)}, {'rows': response.rows.filter(r, ${isDate("r[x]")}).map(r, {'x': r[x].substring(0, 10), 'value': ${value}})}))`,
  };
}

function funnel(stages: readonly string[], percent: boolean): Drawn {
  const stage = (name: string) =>
    `{'label': ${cel(name.length > FUNNEL_LABEL ? `${name.slice(0, FUNNEL_LABEL - 1)}…` : name)}, 'value': size(response.rows) == 0 ? dyn(null) : cel.bind(v, ${column(name)}, ${number("response.rows[0]", "v", percent)})}`;

  return {
    ...(percent ? { value_format: PERCENT } : {}),
    type: "funnel_chart",
    render: {},
    transform: `{'stages': [${stages.map(stage).join(", ")}]}`,
  };
}

function treemap(
  widget: Widget & { type: "treemap" },
  percent: boolean
): Drawn {
  const group =
    widget.group === undefined
      ? "null"
      : `cel.bind(g, ${column(widget.group)}, ${treemapName("r[g]", TREEMAP_GROUP, "dyn(null)")})`;
  const item = `{'label': ${treemapName("r[l]", TREEMAP_LABEL, cel(NO_NAME))}, 'value': ${number("r", "v", percent)}, 'group': ${group}}`;
  const empty = `[{'label': ${cel(NO_NAME)}, 'value': null, 'group': null}]`;

  return {
    ...(percent ? { value_format: PERCENT } : {}),
    type: "treemap_chart",
    render: {},
    transform: `cel.bind(l, ${column(widget.label)}, cel.bind(v, ${column(widget.value)}, cel.bind(items, response.shownRows.map(r, ${item}), {'items': size(items) == 0 ? ${empty} : items})))`,
  };
}

// INVARIANT: no chart sets drill_down; a scatter names no point, since FrontX scatter data has no label.
function scatter(
  widget: Widget & { type: "scatter" },
  percent: (name: string) => boolean
): Drawn | Note {
  if (widget.series !== undefined) return { note: NEEDS_PLANNED_OFF };

  const both = percent(widget.x) && percent(widget.y);
  const coordinate = (name: string) =>
    `(r[${name}] == null ? dyn(null) : dyn(double(r[${name}])${both ? " / 100.0" : ""}))`;
  const size =
    widget.size === undefined
      ? ""
      : `, 'size': (r[s] == null ? dyn(null) : dyn(double(r[s]) < 0.0 ? 0.0 : double(r[s])))`;
  const point = `{'x': ${coordinate("x")}, 'y': ${coordinate("y")}${size}}`;
  const bound = (body: string) =>
    widget.size === undefined
      ? body
      : `cel.bind(s, ${column(widget.size)}, ${body})`;

  return {
    ...(both ? { value_format: PERCENT } : {}),
    type: "cartesian_chart",
    render: {
      series: [{ name: widget.y, type: "scatter" }],
      x_axis: { type: "value" },
      y_axis: { type: "value" },
      legend_position: "none",
      ...(widget.size === undefined ? {} : { size_label: widget.size }),
    },
    transform: `cel.bind(x, ${column(widget.x)}, cel.bind(y, ${column(widget.y)}, ${bound(`{'series': [{'name': ${cel(widget.y)}, 'points': response.rows.filter(r, r[x] != null && r[y] != null).map(r, ${point})}]}`)}))`,
  };
}

function drawn(
  widget: Widget,
  percents: readonly string[],
  daily: boolean
): Drawn | Note {
  const percent = (name: string) => percents.includes(name);

  switch (widget.type) {
    case "table":
      return {
        type: "grid",
        render: {
          columns: widget.columns.map((name, index) => ({
            key: `c${index}`,
            title: name,
            width: columnWidth(name),
            ...(percent(name) ? { value_format: PERCENT_COLUMN } : {}),
          })),
        },
        transform: `{'rows': response.shownRows.map(r, [${widget.columns.map((name) => (percent(name) ? number("r", column(name), true) : `r[${column(name)}]`)).join(", ")}]), 'total_rows': size(response.rows)}`,
      };
    case "line":
    case "area": {
      const lines = targetLines(widget.target, percent(widget.y));
      if (widget.series) {
        return seriesPerValue(
          { ...widget, series: widget.series },
          percent(widget.y),
          widget.type === "area",
          lines
        );
      }
      return oneSeries(widget, widget.type, percent(widget.y), lines);
    }
    case "bar": {
      const share = widget.series !== undefined && widget.stack === "percent";
      const render = {
        ...(widget.horizontal ? { orientation: "horizontal" } : {}),
        ...(share ? { stack_mode: "percent" } : {}),
        ...targetLines(widget.target, percent(widget.y) || share),
      };
      if (widget.series) {
        return seriesPerValue(
          { ...widget, series: widget.series },
          percent(widget.y),
          true,
          render
        );
      }
      return oneSeries(widget, "bar", percent(widget.y), {
        ...render,
        value_labels: widget.labels ? "always" : "never",
      });
    }
    case "stat": {
      const shown = percent(widget.value);
      const reference = widget.compare
        ? `, 'reference_value': ${previousFigure(widget.value, shown)}`
        : "";
      return {
        type: "metric_card",
        ...(shown ? { value_format: PERCENT } : {}),
        render: {
          value_label: widget.label ?? widget.value,
          ...(widget.compare
            ? {
                better: widget.compare.better ?? "higher",
                reference_label: PREVIOUS_PERIOD,
              }
            : {}),
        },
        transform: `size(response.rows) == 0 ? dyn({'value': null}) : dyn(cel.bind(v, ${column(widget.value)}, {'value': ${number("response.rows[0]", "v", shown, true)}${reference}}))`,
      };
    }
    case "pie":
      return {
        type: "pie_chart",
        ...(percent(widget.value) ? { value_format: PERCENT } : {}),
        render: {
          radius: ["80%"],
          legend_position: "bottom",
        },
        transform: `cel.bind(l, ${column(widget.label)}, cel.bind(v, ${column(widget.value)}, {'slices': response.rows.map(r, {'label': r[l], 'value': ${number("r", "v", percent(widget.value))}})}))`,
      };
    case "heatmap":
      return heatmap(widget, percent(widget.value), daily);
    case "funnel":
      return funnel(widget.stages, widget.stages.every(percent));
    case "treemap":
      return treemap(widget, percent(widget.value));
    case "scatter":
      return scatter(widget, percent);
    default:
      return { note: UNKNOWN };
  }
}

function widgetCell(
  dashboard: string,
  widget: DashboardWidget,
  shape: Drawn,
  key: string,
  windowed: boolean
): DashboardCell {
  const title = widget.body.title ?? widget.name;
  const instance = (role: string): WidgetInstance => ({
    id: dataWidgetId(shape.type, `${dashboard}/${key}/${role}`),
    title,
    ...(windowed && !widget.clock ? { description: "All time" } : {}),
    render: shape.render,
    ...(shape.value_format ? { value_format: shape.value_format } : {}),
    data: {
      request: runRequest(dashboard, widget, windowed),
      transform: shape.transform,
    },
  });

  if (widget.body.type === "stat") {
    return { size: "medium", height: "low", widget: instance("cell") };
  }
  return {
    size: "medium",
    height: "high",
    widget: instance("cell"),
    larger_view: instance("larger"),
  };
}

// INVARIANT: an Insight heading or text is plain text, so its whitespace collapses as in HTML and no ASCII punctuation is markdown.
const plain = (text: string) =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[!-/:-@[-`{-~]/g, "\\$&");

const GONE = plain("This widget is no longer on the dashboard.");

const UNKNOWN = plain("Unknown widget type.");

const NEEDS_PLANNED_OFF = plain(
  "Turn off Show planned sections to see this chart."
);

function noteCell(dashboard: string, key: string, body: string): DashboardCell {
  return {
    size: "medium",
    height: "low",
    widget: { id: markdownId(`${dashboard}/${key}`), render: { body } },
  };
}

// INVARIANT: a markdown_card refuses an empty body, and a blank Insight text shows nothing.
function proseCells(
  dashboard: string,
  key: string,
  text: string,
  body: string
): DashboardCell[] {
  if (!text.trim()) return [];

  return [
    {
      size: "large",
      frame: false,
      widget: {
        id: markdownId(`${dashboard}/${key}`),
        render: { body },
      },
    },
  ];
}

// INVARIANT: a cell id comes from its item and the item's repeat count, not its position, so an insert keeps the other cells drawn.
function itemKeys(items: DashboardItem[]): string[] {
  const seen = new Map<string, number>();

  return items.map((item) => {
    const key = JSON.stringify(item);
    const repeat = seen.get(key) ?? 0;
    seen.set(key, repeat + 1);
    return `${key}/${repeat}`;
  });
}

// WORKAROUND: the kit Grid moves a low cell beside a high one to a row of its own, and the current board keeps the two
// side by side. So each two framed cells in a row get the taller height of the two.
function paired(cells: DashboardCell[]): DashboardCell[] {
  const out: DashboardCell[] = [];
  let row: DashboardCell[] = [];
  const flush = () => {
    const high = row.some((cell) => cell.height === "high");
    out.push(
      ...row.map((cell) => (high ? { ...cell, height: "high" as const } : cell))
    );
    row = [];
  };

  for (const cell of cells) {
    if (cell.frame === false) {
      flush();
      out.push(cell);
      continue;
    }
    row.push(cell);
    if (row.length === 2) flush();
  }
  flush();

  return out;
}

export function frontxBoard(
  id: string,
  read: DashboardRead,
  widgets: DashboardWidget[],
  range?: string
): FrontxBoard {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const windowed = (read.body.time_ranges ?? []).length > 0;
  const daily = dailyBuckets(range);

  const items = dashboardItems(read.body);
  const keys = itemKeys(items);
  const drawnWidgets = new Map<string, DashboardWidget>();

  const cells = items.flatMap((item, index) => {
    const key = keys[index];
    if ("heading" in item) {
      return proseCells(id, key, item.heading, `## ${plain(item.heading)}`);
    }
    if ("text" in item) return proseCells(id, key, item.text, plain(item.text));

    const widget = byId.get(item.widget);
    if (!widget) return [noteCell(id, key, GONE)];

    const shape = drawn(widget.body, widget.percents ?? [], daily);
    if ("note" in shape) return [noteCell(id, key, shape.note)];

    const cell = widgetCell(id, widget, shape, key, windowed);
    drawnWidgets.set(cell.widget.id, widget);
    if (cell.larger_view) drawnWidgets.set(cell.larger_view.id, widget);
    return [cell];
  });

  const dashboardId = `${DASHBOARD_TYPE_ID}${uuidv5(id, NAMESPACE)}`;
  const dashboard: FrontxDashboard = {
    id: dashboardId,
    title: read.body.title || read.name,
    // INVARIANT: Insight draws two medium cells in a row, and a flexible grid packs three.
    layout: { cells: paired(cells), flexible: false },
  };

  return {
    dashboardId,
    file: {
      types: catalog.types,
      instances: [...catalog.instances, { ...dashboard }],
    },
    runs: new Map(
      widgets.map((widget) => [
        runPath(id, widget.id),
        { dashboard: id, widget },
      ])
    ),
    widgets: drawnWidgets,
  };
}

function largestRows(result: MetricResult, value: string): unknown[][] {
  const at = result.columns.indexOf(value);
  const size = (row: unknown[]) => {
    const amount = Number(row[at]);
    return row[at] == null || !Number.isFinite(amount) ? -Infinity : amount;
  };

  return result.rows
    .toSorted((a, b) => size(b) - size(a))
    .slice(0, TREEMAP_ITEMS);
}

// WORKAROUND: CEL has no list indexOf, no group function, no sort and no slice, so the answer carries
// each column's position, its distinct values in the order the current stacked chart uses, and the rows a cell shows:
// the first rows of a table, or the largest tiles of a treemap.
export function frontxAnswer(
  result: MetricResult,
  widget: Widget
): FrontxAnswer {
  const at = Object.fromEntries(
    result.columns.map((name, index) => [name, index])
  );
  const label = (value: unknown) => String(value ?? "—");
  const distinct = Object.fromEntries(
    result.columns.map((name, index) => [
      name,
      [...new Set(result.rows.map((row) => row[index]))].sort((a, b) =>
        label(a).localeCompare(label(b), "en", { numeric: true })
      ),
    ])
  );

  return {
    ...result,
    at,
    distinct,
    shownRows:
      widget.type === "treemap"
        ? largestRows(result, widget.value)
        : result.rows.slice(0, TABLE_ROWS),
  };
}
