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
}

export interface FrontxAnswer extends MetricResult {
  at: Record<string, number>;
  distinct: Record<string, unknown[]>;
}

const NAMESPACE = uuidv5("insight.custom.dashboards");

const cel = JSON.stringify;

const column = (name: string) => `int(response.at[${cel(name)}])`;

// WORKAROUND: CEL types both ternary branches alike, so a nullable number goes through dyn.
// INVARIANT: an Insight percent column holds 0 to 100, and a FrontX percent format reads a fraction.
const number = (row: string, at: string, percent = false) =>
  `(${row}[${at}] == null ? dyn(null) : dyn(double(${row}[${at}])${percent ? " / 100.0" : ""}))`;

const PERCENT = { value_type: "percent" } as const;

const PERCENT_COLUMN = { value_type: "percent", decimals: 1 } as const;

// WORKAROUND: the warehouse writes a bucket as a UTC `2026-11-03 00:00:00`, and the FrontX time
// axis reads only ISO 8601 with a zone. CEL has no replace.
const instant = (value: string) =>
  `(type(${value}) == string && size(${value}) > 10 && ${value}.substring(10, 11) == ' ' ? dyn(${value}.substring(0, 10) + 'T' + ${value}.substring(11) + 'Z') : ${value})`;

const DATE = cel(String.raw`^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])`);

const MONTHS = cel(
  "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")
);

const isDate = (value: string) =>
  `(type(${value}) == string && ${value}.matches(${DATE}))`;

const spansYears = `cel.bind(ys, response.rows.filter(r, ${isDate("r[x]")}).map(r, r[x].substring(0, 4)), ys.exists(yr, yr != ys[0]))`;

// WORKAROUND: a FrontX category axis writes a date as it arrives, and the current chart writes `Nov 3`.
const shortDate = (value: string) =>
  `(${isDate(value)} ? dyn(${MONTHS}[int(${value}.substring(5, 7)) - 1] + ' ' + string(int(${value}.substring(8, 10))) + (w ? ', ' + ${value}.substring(0, 4) : '')) : ${value})`;

// INVARIANT: `point` reads a row `r`, and the transform binds `x` to the x column and `w` to `withYear`.
function xAxis(x: string) {
  if (x === "bucket") {
    return { type: "time", withYear: "false", point: instant("r[x]") };
  }
  return { type: "category", withYear: spansYears, point: shortDate("r[x]") };
}

function dataWidgetId(type: string, key: string): string {
  return `${DATA_WIDGET_TYPE_ID}frontx.dashboard.widget.${type}.v1~${uuidv5(key, NAMESPACE)}`;
}

function markdownId(key: string): string {
  return `${WIDGET_BASE_TYPE_ID}frontx.dashboard.widget.markdown_card.v1~${uuidv5(key, NAMESPACE)}`;
}

function runRequest(
  dashboard: string,
  widget: DashboardWidget,
  windowed: boolean
): DashboardRequest {
  const path = `${dashboardWidgetPath(dashboard, widget.id)}/run`;
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
  const axis = xAxis(x);
  const point = `{'x': ${axis.point}, 'y': ${number("r", "y", percent)}}`;

  return {
    ...(percent ? { value_format: PERCENT } : {}),
    type: "cartesian_chart",
    render: {
      ...render,
      x_axis: { type: axis.type },
      y_axis: { type: "value" },
      drill_down: true,
    },
    transform: `cel.bind(x, ${column(x)}, cel.bind(w, ${axis.withYear}, cel.bind(y, ${column(y)}, {'series': ${series(point, cel(y))}})))`,
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
            ...(percent(name) ? { value_format: PERCENT_COLUMN } : {}),
          })),
        },
        transform: `{'rows': response.rows.map(r, [${widget.columns.map((name) => (percent(name) ? number("r", column(name), true) : `r[${column(name)}]`)).join(", ")}])}`,
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
        render: widget.label ? { value_label: widget.label } : {},
        transform: `size(response.rows) == 0 ? dyn({'value': null}) : dyn(cel.bind(v, ${column(widget.value)}, {'value': ${number("response.rows[0]", "v", percent(widget.value))}}))`,
      };
    case "pie":
      return {
        type: "pie_chart",
        ...(percent(widget.value) ? { value_format: PERCENT } : {}),
        render: {
          radius: ["50%", "80%"],
          legend_position: "right",
          drill_down: true,
        },
        transform: `cel.bind(l, ${column(widget.label)}, cel.bind(v, ${column(widget.value)}, {'slices': response.rows.map(r, {'label': r[l], 'value': ${number("r", "v", percent(widget.value))}})}))`,
      };
  }
}

function widgetCell(
  dashboard: string,
  widget: DashboardWidget,
  index: number,
  windowed: boolean
): DashboardCell {
  const shape = drawn(widget.body, widget.percents ?? []);
  const title = widget.body.title ?? widget.name;
  const instance = (role: string): WidgetInstance => ({
    id: dataWidgetId(shape.type, `${dashboard}/${index}/${widget.id}/${role}`),
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

// INVARIANT: a markdown_card refuses an empty body, and a blank Insight text shows nothing.
function proseCells(
  dashboard: string,
  index: number,
  text: string,
  body = text
): DashboardCell[] {
  if (!text.trim()) return [];

  return [
    {
      size: "large",
      frame: false,
      widget: {
        id: markdownId(`${dashboard}/${index}/prose`),
        render: { body },
      },
    },
  ];
}

export function frontxBoard(
  id: string,
  read: DashboardRead,
  widgets: DashboardWidget[]
): FrontxBoard {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const windowed = (read.body.time_ranges ?? []).length > 0;

  const cells = dashboardItems(read.body).flatMap((item, index) => {
    if ("heading" in item) {
      return proseCells(id, index, item.heading, `### ${item.heading}`);
    }
    if ("text" in item) return proseCells(id, index, item.text);

    const widget = byId.get(item.widget);
    return widget ? [widgetCell(id, widget, index, windowed)] : [];
  });

  const dashboardId = `${DASHBOARD_TYPE_ID}${uuidv5(id, NAMESPACE)}`;
  const dashboard: FrontxDashboard = {
    id: dashboardId,
    title: read.body.title || read.name,
    // INVARIANT: Insight draws two medium cells in a row, and a flexible grid packs three.
    layout: { cells, flexible: false },
  };

  return {
    dashboardId,
    file: {
      types: catalog.types,
      instances: [...catalog.instances, { ...dashboard }],
    },
  };
}

// WORKAROUND: CEL has no list indexOf and no group function, so the answer carries
// each column's position and its distinct values in the order they first come.
export function frontxAnswer(result: MetricResult): FrontxAnswer {
  const at = Object.fromEntries(
    result.columns.map((name, index) => [name, index])
  );
  const distinct = Object.fromEntries(
    result.columns.map((name, index) => [
      name,
      [...new Set(result.rows.map((row) => row[index]))],
    ])
  );

  return { ...result, at, distinct };
}
