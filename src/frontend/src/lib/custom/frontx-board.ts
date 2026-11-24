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
  BASE,
  type DashboardRead,
  type DashboardWidget,
  type Widget,
} from "@/api/custom-client";
import { dashboardItems } from "@/lib/custom/dashboard-items";
import { drawsBucket } from "@/lib/custom/draws-bucket";

/*
 * Prototype: an Insight dashboard as a FrontX dashboard file.
 *
 * Every widget keeps its own run request. The host answers it with the run
 * result plus `at`, each column's position, since CEL has no list indexOf.
 */

export interface FrontxBoard {
  dashboardId: string;
  file: ServedFile;
}

const NAMESPACE = uuidv5("insight.custom.dashboards");

const cel = JSON.stringify;

const column = (name: string) => `int(response.at[${cel(name)}])`;

// CEL types both ternary branches alike, so a nullable number goes through dyn.
// An Insight percent column holds 0 to 100; a FrontX percent format reads a fraction.
const number = (row: string, at: string, percent = false) =>
  `(${row}[${at}] == null ? dyn(null) : dyn(double(${row}[${at}])${percent ? " / 100.0" : ""}))`;

// A grid has one value format, so a percent column becomes text. CEL has no
// round, so the one decimal the current table shows is kept by hand.
const percentText = (cell: string) =>
  `(${cell} == null ? dyn(null) : dyn(string(double(int(double(${cell}) * 10.0 + (double(${cell}) < 0.0 ? -0.5 : 0.5))) / 10.0) + '%'))`;

const PERCENT = { value_type: "percent" } as const;

// The warehouse writes a bucket as a UTC `2026-11-03 00:00:00`. The FrontX time
// axis reads only ISO 8601 with a zone. CEL here has no replace.
const instant = (value: string) =>
  `(type(${value}) == string && size(${value}) > 10 && ${value}.substring(10, 11) == ' ' ? dyn(${value}.substring(0, 10) + 'T' + ${value}.substring(11) + 'Z') : ${value})`;

const DATE = cel(String.raw`^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])`);

const MONTHS = cel(
  "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")
);

const isDate = (value: string) =>
  `(type(${value}) == string && ${value}.matches(${DATE}))`;

// A FrontX category axis writes a date as it arrives. The current chart writes
// `Nov 3`, and adds the year when the dates span more than one.
const spansYears = `cel.bind(ys, response.rows.filter(r, ${isDate("r[x]")}).map(r, r[x].substring(0, 4)), ys.exists(yr, yr != ys[0]))`;

const shortDate = (value: string) =>
  `(${isDate(value)} ? dyn(${MONTHS}[int(${value}.substring(5, 7)) - 1] + ' ' + string(int(${value}.substring(8, 10))) + (w ? ', ' + ${value}.substring(0, 4) : '')) : ${value})`;

// INVARIANT: `point` reads a row `r`, and the transform binds `w` to `withYear`.
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
  const path = `${BASE}/dashboards/${encodeURIComponent(dashboard)}/widgets/${encodeURIComponent(widget.id)}/run`;
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

function series(
  widget: Widget & { x: string; y: string },
  kind: string,
  percent: boolean
): Drawn {
  const axis = xAxis(widget.x);

  return {
    ...(percent ? { value_format: PERCENT } : {}),
    type: "cartesian_chart",
    render: {
      series: [{ name: widget.y, type: kind }],
      x_axis: { type: axis.type },
      y_axis: { type: "value" },
      legend_position: "none",
      drill_down: true,
    },
    transform: `cel.bind(x, ${column(widget.x)}, cel.bind(w, ${axis.withYear}, cel.bind(y, ${column(widget.y)}, {'series': [{'name': ${cel(widget.y)}, 'points': response.rows.map(r, {'x': ${axis.point}, 'y': ${number("r", "y", percent)}})}]})))`,
  };
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
          })),
        },
        transform: `{'rows': response.rows.map(r, [${widget.columns.map((name) => (percent(name) ? percentText(`r[${column(name)}]`) : `r[${column(name)}]`)).join(", ")}])}`,
      };
    case "line":
    case "area":
      return series(widget, widget.type, percent(widget.y));
    case "bar": {
      if (!widget.series) {
        const bars = series(widget, "bar", percent(widget.y));
        return {
          ...bars,
          render: {
            ...bars.render,
            value_labels: widget.labels ? "always" : "never",
          },
        };
      }
      // CEL cannot group rows by a column, so each row is its own series.
      const axis = xAxis(widget.x);
      return {
        type: "cartesian_chart",
        ...(percent(widget.y) ? { value_format: PERCENT } : {}),
        render: {
          x_axis: { type: axis.type },
          y_axis: { type: "value" },
          legend_position: "bottom",
          drill_down: true,
        },
        transform: `cel.bind(x, ${column(widget.x)}, cel.bind(w, ${axis.withYear}, cel.bind(y, ${column(widget.y)}, cel.bind(s, ${column(widget.series)}, {'series': response.rows.map(r, {'name': string(r[s]), 'points': [{'x': ${axis.point}, 'y': ${number("r", "y", percent(widget.y))}}]})}))))`,
      };
    }
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

function proseCell(
  dashboard: string,
  index: number,
  body: string
): DashboardCell {
  return {
    size: "large",
    frame: false,
    widget: { id: markdownId(`${dashboard}/${index}/prose`), render: { body } },
  };
}

/** The board as a FrontX served file, or nothing when it draws nothing. */
export function frontxBoard(
  id: string,
  read: DashboardRead,
  widgets: DashboardWidget[]
): FrontxBoard {
  const byId = new Map(widgets.map((widget) => [widget.id, widget]));
  const windowed = (read.body.time_ranges ?? []).length > 0;

  const cells = dashboardItems(read.body).flatMap((item, index) => {
    if ("heading" in item) return [proseCell(id, index, `### ${item.heading}`)];
    if ("text" in item) return [proseCell(id, index, item.text)];

    const widget = byId.get(item.widget);
    return widget ? [widgetCell(id, widget, index, windowed)] : [];
  });

  const dashboardId = `${DASHBOARD_TYPE_ID}${uuidv5(id, NAMESPACE)}`;
  const dashboard: FrontxDashboard = {
    id: dashboardId,
    title: read.body.title || read.name,
    // A flexible grid packs three medium cells into a row; Insight draws two.
    layout: { cells, flexible: false },
  };

  return {
    dashboardId,
    file: {
      types: (catalog as ServedFile).types,
      instances: [{ ...dashboard }],
    },
  };
}
