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
  type Widget,
} from "@/api/custom-client";
import { dashboardItems } from "@/lib/custom/dashboard-items";
import { drawsBucket } from "@/lib/custom/draws-bucket";

export interface FrontxBoard {
  dashboardId: string;
  file: ServedFile;
  runs: ReadonlyMap<string, { dashboard: string; widget: string }>;
  widgets: ReadonlyMap<string, DashboardWidget>;
}

export interface FrontxAnswer extends MetricResult {
  at: Record<string, number>;
  distinct: Record<string, unknown[]>;
  tableRows: unknown[][];
}

// INVARIANT: FrontX grid data holds at most 500 rows, and a longer list fails the cell.
const TABLE_ROWS = 500;

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
      drill_down: true,
    },
    transform: `cel.bind(x, ${column(x)}, cel.bind(w, ${spansYears}, cel.bind(y, ${column(y)}, {'series': ${series(point, cel(y))}})))`,
  };
}

function oneSeries(
  widget: Widget & { x: string; y: string },
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

function seriesPerValue(
  widget: Widget & { x: string; y: string; series: string },
  percent: boolean
): Drawn {
  const values = `response.distinct[${cel(widget.series)}]`;
  const name = `(v == null ? dyn(null) : dyn(string(v)))`;

  return chart(
    widget.x,
    widget.y,
    percent,
    { legend_position: "bottom", unlisted_stack_group: widget.series },
    (point) =>
      `cel.bind(s, ${column(widget.series)}, ${values}.map(v, {'name': ${name}, 'points': response.rows.filter(r, r[s] == v).map(r, ${point})}))`
  );
}

function drawn(widget: Widget, percents: readonly string[]): Drawn {
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
        transform: `{'rows': response.tableRows.map(r, [${widget.columns.map((name) => (percent(name) ? number("r", column(name), true) : `r[${column(name)}]`)).join(", ")}]), 'total_rows': size(response.rows)}`,
      };
    case "line":
    case "area":
      return oneSeries(widget, widget.type, percent(widget.y));
    case "bar":
      if (widget.series) {
        return seriesPerValue(
          { ...widget, series: widget.series },
          percent(widget.y)
        );
      }
      return oneSeries(widget, "bar", percent(widget.y), {
        value_labels: widget.labels ? "always" : "never",
      });
    case "stat":
      return {
        type: "metric_card",
        ...(percent(widget.value) ? { value_format: PERCENT } : {}),
        render: { value_label: widget.label ?? widget.value },
        transform: `size(response.rows) == 0 ? dyn({'value': null}) : dyn(cel.bind(v, ${column(widget.value)}, {'value': ${number("response.rows[0]", "v", percent(widget.value), true)}}))`,
      };
    case "pie":
      return {
        type: "pie_chart",
        ...(percent(widget.value) ? { value_format: PERCENT } : {}),
        render: {
          radius: ["80%"],
          legend_position: "bottom",
          drill_down: true,
        },
        transform: `cel.bind(l, ${column(widget.label)}, cel.bind(v, ${column(widget.value)}, {'slices': response.rows.map(r, {'label': r[l], 'value': ${number("r", "v", percent(widget.value))}})}))`,
      };
  }
}

function widgetCell(
  dashboard: string,
  widget: DashboardWidget,
  key: string,
  windowed: boolean
): DashboardCell {
  const shape = drawn(widget.body, widget.percents ?? []);
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

function goneCell(dashboard: string, key: string): DashboardCell {
  return {
    size: "medium",
    height: "low",
    widget: { id: markdownId(`${dashboard}/${key}`), render: { body: GONE } },
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
  widgets: DashboardWidget[]
): FrontxBoard {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const windowed = (read.body.time_ranges ?? []).length > 0;

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
    if (!widget) return [goneCell(id, key)];

    const cell = widgetCell(id, widget, key, windowed);
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
        { dashboard: id, widget: widget.id },
      ])
    ),
    widgets: drawnWidgets,
  };
}

// WORKAROUND: CEL has no list indexOf, no group function, no sort and no slice, so the answer carries
// each column's position, its distinct values in the order the current stacked chart uses, and the rows a table shows.
export function frontxAnswer(result: MetricResult): FrontxAnswer {
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
    tableRows: result.rows.slice(0, TABLE_ROWS),
  };
}
