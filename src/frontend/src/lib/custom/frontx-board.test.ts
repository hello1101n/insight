import type { Dashboard as FrontxDashboard } from "@gears-frontx/frontx-dashboard-root/contract";
import { describe, expect, it } from "vitest";

import type {
  DashboardItem,
  DashboardRead,
  DashboardWidget,
  MetricResult,
  Widget,
} from "@/api/custom-client";
import { frontxBoard } from "@/lib/custom/frontx-board";

// The FrontX root runs transforms with this module; the package does not export it.
import { compileTransform } from "../../../vendor/frontx-dashboard-root/src/runtime/cel";

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

  it("reads a date bucket on the x axis as time, any other column as a category, and titles no axis", () => {
    const [line, bar, stacked] = cells([
      { widget: "line" },
      { widget: "bar" },
      { widget: "stacked" },
    ]);

    expect(line.widget.render).toMatchObject({
      x_axis: { type: "time" },
      y_axis: { type: "value" },
    });
    expect(bar.widget.render).toMatchObject({
      x_axis: { type: "category" },
      y_axis: { type: "value" },
    });
    for (const cell of [line, bar, stacked]) {
      const render = cell.widget.render as Record<string, object>;
      expect(render.x_axis, cell.widget.title).not.toHaveProperty("label");
      expect(render.y_axis, cell.widget.title).not.toHaveProperty("label");
    }
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
      layout: { flexible: false },
    });
    expect(dashboard.layout.cells.map((cell) => cell.widget.title)).toEqual([
      "Rate",
      "line name",
    ]);
    expect(board.file.types.length).toBeGreaterThan(0);
  });
});

function drawnData(body: Widget, percents: string[], answer: MetricResult) {
  const board = frontxBoard("board", read([{ widget: "w" }]), [
    { ...widget("w", body), percents },
  ]);
  const [cell] = dashboardOf(board).layout.cells;
  const at = Object.fromEntries(answer.columns.map((name, i) => [name, i]));
  const data = compileTransform(bound(cell).data.transform).evaluate({
    response: { ...answer, at },
  });

  return { format: cell.widget.value_format, data };
}

describe("frontxBoard x values", () => {
  const LINE: Widget = { type: "line", metric: "m", x: "bucket", y: "runs" };
  const BAR: Widget = { type: "bar", metric: "m", x: "day", y: "runs" };
  const STACKED: Widget = { ...BAR, series: "outcome" };

  function xs(body: Widget, values: unknown[]): unknown[] {
    const columns = [
      body.type === "line" ? "bucket" : "day",
      "runs",
      "outcome",
    ];
    const rows = values.map((value) => [value, 1, "ok"]);
    const { data } = drawnData(body, [], { columns, rows });

    return (data as { series: { points: { x: unknown }[] }[] }).series.flatMap(
      (series) => series.points.map((point) => point.x)
    );
  }

  it.each<[string, unknown, unknown]>([
    ["a date-time", "2026-11-03 00:00:00", "2026-11-03T00:00:00Z"],
    ["an hour bucket", "2026-11-03 14:00:00", "2026-11-03T14:00:00Z"],
    [
      "fractional seconds",
      "2026-11-03 00:00:00.000",
      "2026-11-03T00:00:00.000Z",
    ],
    ["a date", "2026-11-03", "2026-11-03"],
    ["epoch milliseconds", 1_793_664_000_000, 1_793_664_000_000],
    ["null", null, null],
  ])(
    "hands a bucket that is %s to the time axis as ISO 8601",
    (kind, value, x) => {
      expect(xs(LINE, [value]), kind).toEqual([x]);
    }
  );

  it.each<[string, Widget]>([
    ["bar", BAR],
    ["bar with a series column", STACKED],
  ])(
    "writes a date category of a %s as the current chart does",
    (kind, body) => {
      expect(
        xs(body, ["2026-11-03", "2026-11-04 00:00:00", "team", 7, null]),
        kind
      ).toEqual(["Nov 3", "Nov 4", "team", 7, null]);
      expect(xs(body, ["2026-12-31", "2027-01-01"]), kind).toEqual([
        "Dec 31, 2026",
        "Jan 1, 2027",
      ]);
    }
  );

  it("leaves a string that only starts like a date with no real month as it is", () => {
    expect(xs(BAR, ["2026-13-01", "2026-00-10"])).toEqual([
      "2026-13-01",
      "2026-00-10",
    ]);
  });

  it("draws no points for no rows", () => {
    expect(xs(BAR, [])).toEqual([]);
  });
});

describe("frontxBoard percent columns", () => {
  // An Insight percent column holds 0 to 100, as the run endpoint answers it.
  const STAT: Widget = { type: "stat", metric: "m", value: "rate" };
  const RATE = { columns: ["rate"], rows: [[12.8]] };

  it("shows a percent stat as a FrontX percent of the fraction", () => {
    expect(drawnData(STAT, ["rate"], RATE)).toEqual({
      format: { value_type: "percent" },
      data: { value: 0.128 },
    });
  });

  it("leaves a stat that is not a percent as the number it is", () => {
    expect(drawnData(STAT, [], RATE)).toEqual({
      format: undefined,
      data: { value: 12.8 },
    });
  });

  it("keeps an empty or null percent stat empty", () => {
    expect(
      drawnData(STAT, ["rate"], { columns: ["rate"], rows: [] }).data
    ).toEqual({ value: null });
    expect(
      drawnData(STAT, ["rate"], { columns: ["rate"], rows: [[null]] }).data
    ).toEqual({ value: null });
  });

  it.each<[string, Widget, MetricResult, unknown]>([
    [
      "line",
      { type: "line", metric: "m", x: "bucket", y: "rate" },
      { columns: ["bucket", "rate"], rows: [["2026-10-01", 50]] },
      { series: [{ name: "rate", points: [{ x: "2026-10-01", y: 0.5 }] }] },
    ],
    [
      "bar with a series column",
      { type: "bar", metric: "m", x: "team", y: "rate", series: "outcome" },
      { columns: ["team", "outcome", "rate"], rows: [["Atlas", "ok", 25]] },
      { series: [{ name: "ok", points: [{ x: "Atlas", y: 0.25 }] }] },
    ],
    [
      "pie",
      { type: "pie", metric: "m", label: "state", value: "rate" },
      { columns: ["state", "rate"], rows: [["open", 75]] },
      { slices: [{ label: "open", value: 0.75 }] },
    ],
  ])(
    "divides a percent %s by 100 and formats it as a percent",
    (kind, body, answer, data) => {
      expect(drawnData(body, ["rate"], answer), kind).toEqual({
        format: { value_type: "percent" },
        data,
      });
    }
  );

  it("writes a percent table column as text with one decimal and leaves the others", () => {
    const table: Widget = {
      type: "table",
      metric: "m",
      columns: ["team", "rate", "runs"],
    };
    const answer = {
      columns: ["team", "runs", "rate"],
      rows: [
        ["Atlas", 40, 97.333],
        ["Borealis", 12, -2.25],
        ["Cobalt", 3, null],
      ],
    };

    expect(drawnData(table, ["rate"], answer)).toEqual({
      format: undefined,
      data: {
        rows: [
          ["Atlas", "97.3%", 40],
          ["Borealis", "-2.3%", 12],
          ["Cobalt", null, 3],
        ],
      },
    });
  });
});
