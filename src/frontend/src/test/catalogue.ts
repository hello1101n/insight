import type {
  MetricDefinition,
  MetricListed,
  NamePage,
  Widget,
  WidgetListed,
} from "@/api/custom-client";

const CHANGED = "2026-01-05T09:00:00.000Z";

export function metricListed(
  id: string,
  name: string = id,
  body: MetricDefinition = { table: "silver.example", fields: [] }
): MetricListed {
  return { id, name, updated_at: CHANGED, body };
}

export function widgetListed(
  id: string,
  name: string = id,
  body: Widget = { type: "table", metric: "m-1", columns: [] },
  metricName: string | null = "Example metric"
): WidgetListed {
  return { id, name, updated_at: CHANGED, body, metric_name: metricName };
}

export function datasetNames(names: string[], total = names.length): NamePage {
  return {
    names,
    items: names.map((name) => ({
      name,
      title: null,
      fields: 0,
      updated_at: CHANGED,
    })),
    total,
  };
}
