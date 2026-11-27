import type { Widget } from "@/api/custom-client";

const BUCKET = "bucket";

export function drawnColumns(widget: Widget): string[] {
  return listed(widget).filter((column) => column !== undefined);
}

function listed(widget: Widget): (string | undefined)[] {
  switch (widget.type) {
    case "table":
      return widget.columns;
    case "line":
    case "area":
    case "bar":
      return [widget.x, widget.y, widget.series];
    case "stat":
      return [widget.value];
    case "pie":
      return [widget.label, widget.value];
    case "heatmap":
      return [widget.x, widget.y, widget.value];
    case "funnel":
      return widget.stages;
    case "treemap":
      return [widget.label, widget.value, widget.group];
    case "scatter":
      return [widget.x, widget.y, widget.size, widget.series, widget.label];
    default:
      return [];
  }
}

export function drawsBucket(widget: Widget): boolean {
  return drawnColumns(widget).includes(BUCKET);
}
