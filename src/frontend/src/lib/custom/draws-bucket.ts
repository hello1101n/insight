import type { Widget } from "@/api/custom-client";

const BUCKET = "bucket";

export function drawsBucket(widget: Widget): boolean {
  switch (widget.type) {
    case "table":
      return widget.columns.includes(BUCKET);
    case "line":
    case "area":
      return widget.x === BUCKET || widget.y === BUCKET;
    case "bar":
      return [widget.x, widget.y, widget.series].includes(BUCKET);
    case "stat":
      return widget.value === BUCKET;
    case "pie":
      return widget.label === BUCKET || widget.value === BUCKET;
  }
}
