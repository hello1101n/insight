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
 * Spike: an Insight dashboard as a FrontX dashboard file.
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
const number = (row: string, at: string) =>
  `(${row}[${at}] == null ? dyn(null) : dyn(double(${row}[${at}])))`;

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
  kind: string
): Drawn {
  return {
    type: "cartesian_chart",
    render: {
      series: [{ name: widget.y, type: kind }],
      x_axis: {
        type: widget.x === "bucket" ? "time" : "category",
        label: widget.x,
      },
      y_axis: { type: "value", label: widget.y },
      legend_position: "none",
      drill_down: true,
    },
    transform: `cel.bind(x, ${column(widget.x)}, cel.bind(y, ${column(widget.y)}, {'series': [{'name': ${cel(widget.y)}, 'points': response.rows.map(r, {'x': r[x], 'y': ${number("r", "y")}})}]}))`,
  };
}

function drawn(widget: Widget): Drawn {
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
        transform: `{'rows': response.rows.map(r, [${widget.columns.map((name) => `r[${column(name)}]`).join(", ")}])}`,
      };
    case "line":
    case "area":
      return series(widget, widget.type);
    case "bar":
      if (!widget.series) {
        return {
          ...series(widget, "bar"),
          render: {
            ...series(widget, "bar").render,
            value_labels: widget.labels ? "always" : "never",
          },
        };
      }
      // CEL cannot group rows by a column, so each row is its own series.
      return {
        type: "cartesian_chart",
        render: {
          x_axis: {
            type: widget.x === "bucket" ? "time" : "category",
            label: widget.x,
          },
          y_axis: { type: "value", label: widget.y },
          legend_position: "bottom",
          drill_down: true,
        },
        transform: `cel.bind(x, ${column(widget.x)}, cel.bind(y, ${column(widget.y)}, cel.bind(s, ${column(widget.series)}, {'series': response.rows.map(r, {'name': string(r[s]), 'points': [{'x': r[x], 'y': ${number("r", "y")}}]})})))`,
      };
    case "stat":
      return {
        type: "metric_card",
        render: widget.label ? { value_label: widget.label } : {},
        transform: `size(response.rows) == 0 ? dyn({'value': null}) : dyn(cel.bind(v, ${column(widget.value)}, {'value': ${number("response.rows[0]", "v")}}))`,
      };
    case "pie":
      return {
        type: "pie_chart",
        render: {
          radius: ["50%", "80%"],
          legend_position: "right",
          drill_down: true,
        },
        transform: `cel.bind(l, ${column(widget.label)}, cel.bind(v, ${column(widget.value)}, {'slices': response.rows.map(r, {'label': r[l], 'value': ${number("r", "v")}})}))`,
      };
  }
}

function widgetCell(
  dashboard: string,
  widget: DashboardWidget,
  index: number,
  windowed: boolean
): DashboardCell {
  const shape = drawn(widget.body);
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
    layout: { cells },
  };

  return {
    dashboardId,
    file: {
      types: (catalog as ServedFile).types,
      instances: [{ ...dashboard }],
    },
  };
}
