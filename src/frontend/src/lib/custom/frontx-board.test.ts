import type { Dashboard as FrontxDashboard } from "@gears-frontx/frontx-dashboard-root/contract";
import { describe, expect, it } from "vitest";

import type {
  DashboardItem,
  DashboardRead,
  DashboardWidget,
  Widget,
} from "@/api/custom-client";
import { frontxBoard } from "@/lib/custom/frontx-board";

const CLOCK = { field: "day", from: "metric" } as const;

function widget(
  id: string,
  body: Widget,
  clock: DashboardWidget["clock"] = CLOCK
): DashboardWidget {
  return { id, name: `${id} name`, body, clock };
}

function read(items: DashboardItem[], timeRanges?: string[]): DashboardRead {
  return {
    name: "Board name",
    body: { title: "", items, time_ranges: timeRanges },
    tags: [],
    ownerPersonId: null,
    ownerName: null,
    access: "owner",
    visibility: null,
    folders: [],
    carries: false,
  };
}

const WIDGETS = {
  table: widget("table", {
    type: "table",
    metric: "m",
    columns: ["bucket", "deploys"],
  }),
  line: widget("line", {
    type: "line",
    metric: "m",
    x: "bucket",
    y: "deploys",
  }),
  area: widget("area", { type: "area", metric: "m", x: "bucket", y: "open" }),
  bar: widget("bar", {
    type: "bar",
    metric: "m",
    x: "team",
    y: "deploys",
    labels: true,
  }),
  stacked: widget("stacked", {
    type: "bar",
    metric: "m",
    x: "team",
    y: "deploys",
    series: "outcome",
  }),
  stat: widget("stat", {
    type: "stat",
    metric: "m",
    value: "rate",
    label: "of deploys",
    title: "Rate",
  }),
  pie: widget(
    "pie",
    { type: "pie", metric: "m", label: "state", value: "count" },
    null
  ),
};

const ALL = Object.values(WIDGETS);

// The served file types its instances loosely; the board puts one dashboard there.
function dashboardOf(board: ReturnType<typeof frontxBoard>): FrontxDashboard {
  return board.file.instances[0] as unknown as FrontxDashboard;
}

// FrontX types a cell's data binding as unknown; the board always sets one.
interface Bound {
  data: { request: Record<string, unknown>; transform: string };
}

function bound(cell: FrontxDashboard["layout"]["cells"][number]): Bound {
  return cell.widget as unknown as Bound;
}

function cells(items: DashboardItem[], timeRanges?: string[]) {
  return dashboardOf(frontxBoard("board", read(items, timeRanges), ALL)).layout
    .cells;
}

describe("frontxBoard", () => {
  it("draws one cell per item in order and skips a widget the list does not hold", () => {
    const drawn = cells([
      { heading: "Throughput" },
      { text: "Some words." },
      { widget: "table" },
      { widget: "gone" },
      { widget: "stat" },
    ]);

    expect(drawn).toHaveLength(4);
    expect(drawn[0]).toMatchObject({
      frame: false,
      widget: { render: { body: "### Throughput" } },
    });
    expect(drawn[1]).toMatchObject({
      frame: false,
      widget: { render: { body: "Some words." } },
    });
    expect(drawn[2].widget.id).toContain(".widget.grid.v1~");
    expect(drawn[3].widget.id).toContain(".widget.metric_card.v1~");
  });

  it.each([
    ["table", "grid"],
    ["line", "cartesian_chart"],
    ["area", "cartesian_chart"],
    ["bar", "cartesian_chart"],
    ["stacked", "cartesian_chart"],
    ["stat", "metric_card"],
    ["pie", "pie_chart"],
  ])("draws a %s widget as a FrontX %s", (id, type) => {
    const [cell] = cells([{ widget: id }]);

    expect(cell.widget.id, `widget ${id}`).toContain(`.widget.${type}.v1~`);
  });

  it("sends the range only for a widget with a clock on a board with time ranges", () => {
    const [line, pie] = cells(
      [{ widget: "line" }, { widget: "pie" }],
      ["P7D", "P30D"]
    );
    const [plain] = cells([{ widget: "line" }]);

    expect(bound(line).data.request).toMatchObject({
      method: "POST",
      path: expect.stringContaining("/dashboards/board/widgets/line/run"),
      body: { bucket: true },
      variables: { range: "range" },
    });
    expect(bound(pie).data.request).not.toHaveProperty("variables");
    expect(pie.widget.description).toBe("All time");
    expect(bound(plain).data.request).not.toHaveProperty("body");
    expect(plain.widget).not.toHaveProperty("description");
  });

  it("gives a stat cell a low frame and every other widget a larger view", () => {
    const [stat, line] = cells([{ widget: "stat" }, { widget: "line" }]);

    expect(stat).toMatchObject({ size: "medium", height: "low" });
    expect(stat).not.toHaveProperty("larger_view");
    expect(line).toMatchObject({ size: "medium", height: "high" });
    expect(line.larger_view?.id).not.toBe(line.widget.id);
  });

  it("draws a bar with a series column as one series per row and a bar without one with value labels", () => {
    const [bar, stacked] = cells([{ widget: "bar" }, { widget: "stacked" }]);

    expect(bar.widget.render).toMatchObject({
      value_labels: "always",
      legend_position: "none",
    });
    expect(stacked.widget.render).toMatchObject({ legend_position: "bottom" });
    expect(bound(stacked).data.transform).toContain("string(r[s])");
  });

  it("reads a date bucket on the x axis as time and any other column as a category", () => {
    const [line, bar] = cells([{ widget: "line" }, { widget: "bar" }]);

    expect(line.widget.render).toMatchObject({
      x_axis: { type: "time", label: "bucket" },
    });
    expect(bar.widget.render).toMatchObject({
      x_axis: { type: "category", label: "team" },
    });
  });

  it("titles the board and each widget, and falls back to their names", () => {
    const board = frontxBoard(
      "board",
      read([{ widget: "stat" }, { widget: "line" }]),
      ALL
    );
    const dashboard = dashboardOf(board);

    expect(dashboard).toMatchObject({
      id: board.dashboardId,
      title: "Board name",
    });
    expect(dashboard.layout.cells.map((cell) => cell.widget.title)).toEqual([
      "Rate",
      "line name",
    ]);
    expect(board.file.types.length).toBeGreaterThan(0);
  });
});
