import type { Dashboard as FrontxDashboard } from "@gears-frontx/frontx-dashboard-root/contract";
import { describe, expect, it } from "vitest";

import type {
  DashboardItem,
  DashboardRead,
  DashboardWidget,
  DurationUnit,
  MetricResult,
  Widget,
} from "@/api/custom-client";
import { groupedNumber } from "@/components/custom/chart-format";
import {
  frontxAnswer,
  frontxBoard,
  type FrontxAnswer,
} from "@/lib/custom/frontx-board";

// WORKAROUND: the FrontX root runs transforms with this module, and the package does not export it.
import { compileTransform } from "../../../vendor/gears-frontx-templates/template-dashboard/src-app/mfe_packages/dashboard/src/runtime/cel";
// WORKAROUND: the FrontX widgets write a number with this module, and the package does not export it.
import { formatValue } from "../../../vendor/gears-frontx-templates/template-dashboard/src-app/mfe_packages/widgets/src/format";

const CLOCK = { field: "day", from: "metric" } as const;

function widget(
  id: string,
  body: Widget,
  clock: DashboardWidget["clock"] = CLOCK
): DashboardWidget {
  return { id, name: `${id} name`, body, clock };
}

function read(
  items: DashboardItem[],
  timeRanges?: string[],
  title = ""
): DashboardRead {
  return {
    name: "Board name",
    body: { title, items, time_ranges: timeRanges },
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
  plainBar: widget("plainBar", {
    type: "bar",
    metric: "m",
    x: "team",
    y: "deploys",
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
  it("draws one cell per item in order, and a note for a widget the list does not hold", () => {
    const drawn = cells([
      { heading: "Throughput" },
      { text: "Some words" },
      { widget: "table" },
      { widget: "stat" },
      { widget: "gone" },
    ]);

    expect(drawn).toHaveLength(5);
    expect(drawn[0]).toMatchObject({
      size: "large",
      frame: false,
      widget: { render: { body: "## Throughput" } },
    });
    expect(drawn[1]).toMatchObject({
      size: "large",
      frame: false,
      widget: { render: { body: "Some words" } },
    });
    expect(drawn[4]).toEqual({
      size: "medium",
      height: "low",
      widget: {
        id: expect.stringContaining(".widget.markdown_card.v1~"),
        render: {
          body: String.raw`This widget is no longer on the dashboard\.`,
        },
      },
    });
    expect(drawn[0].widget.id).toContain(".widget.markdown_card.v1~");
    expect(drawn[2].widget.id).toContain(".widget.grid.v1~");
    expect(drawn[3].widget.id).toContain(".widget.metric_card.v1~");
  });

  it("draws a widget of a type it does not know as a note, and still draws the rest of the board", () => {
    const unknown = widget("odd", {
      type: "sankey",
      metric: "m",
    } as unknown as Widget);
    const board = frontxBoard(
      "board",
      read([{ widget: "odd" }, { widget: "line" }]),
      [unknown, WIDGETS.line]
    );
    const [note, line] = dashboardOf(board).layout.cells;

    expect(note.widget).toEqual({
      id: expect.stringContaining(".widget.markdown_card.v1~"),
      title: "odd name",
      render: { body: String.raw`Unknown widget type\.` },
    });
    expect(note).not.toHaveProperty("larger_view");
    expect(board.widgets.has(note.widget.id)).toBe(false);
    expect(line.widget.id).toContain(".widget.cartesian_chart.v1~");
  });

  it("writes a heading and a text as plain text, with their whitespace collapsed", () => {
    const [heading, text] = cells([
      { heading: "Q1 *goals* #1" },
      {
        text: "1. Ship [it](https://example.com) & <b>now</b>\n\n    `soon` _ok_!",
      },
    ]);

    expect(heading.widget.render.body).toBe(String.raw`## Q1 \*goals\* \#1`);
    expect(text.widget.render.body).toBe(
      String.raw`1\. Ship \[it\]\(https\:\/\/example\.com\) \& \<b\>now\<\/b\> \`soon\` \_ok\_\!`
    );
  });

  it("draws no cell for a blank heading or text, which a markdown card refuses", () => {
    const drawn = cells([
      { heading: " " },
      { text: "" },
      { text: "\n" },
      { widget: "line" },
    ]);

    expect(drawn).toHaveLength(1);
    expect(drawn[0].widget.id).toContain(".widget.cartesian_chart.v1~");
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

    expect(cell.widget.id, `widget ${id}`).toMatch(
      new RegExp(
        `^gts\\.frontx\\.dashboard\\.widget\\.widget\\.v1~frontx\\.dashboard\\.widget\\.data_widget\\.v1~frontx\\.dashboard\\.widget\\.${type}\\.v1~[0-9a-f-]{36}$`
      )
    );
  });

  it("gives each cell and larger view its own id, the same on every build", () => {
    const first = cells([{ widget: "line" }, { widget: "line" }]);
    const again = cells([{ widget: "line" }, { widget: "line" }]);
    const ids = first.flatMap((cell) => [cell.widget.id, cell.larger_view?.id]);

    expect(new Set(ids).size).toBe(4);
    expect(
      again.flatMap((cell) => [cell.widget.id, cell.larger_view?.id])
    ).toEqual(ids);
  });

  it("keeps each cell's ids when an item goes in before it", () => {
    const items: DashboardItem[] = [
      { heading: "Throughput" },
      { text: "Some words." },
      { widget: "line" },
      { widget: "stat" },
      { widget: "line" },
      { text: "Some words." },
    ];
    const idsOf = (drawn: ReturnType<typeof cells>) =>
      drawn.map((cell) => [cell.widget.id, cell.larger_view?.id ?? null]);

    const before = idsOf(cells(items));
    const after = idsOf(cells([{ text: "New first line." }, ...items]));

    expect(new Set(before.flat().filter(Boolean)).size).toBe(8);
    expect(after.slice(1)).toEqual(before);
  });

  it("maps each widget cell and larger view back to its Insight widget, and no heading, text or gone cell", () => {
    const board = frontxBoard(
      "board",
      read([
        { heading: "Throughput" },
        { text: "Some words" },
        { widget: "line" },
        { widget: "stat" },
        { widget: "gone" },
      ]),
      ALL
    );
    const [heading, text, line, stat, gone] = dashboardOf(board).layout.cells;

    expect(board.widgets.get(line.widget.id)).toBe(WIDGETS.line);
    expect(board.widgets.get(line.larger_view!.id)).toBe(WIDGETS.line);
    expect(board.widgets.get(stat.widget.id)).toBe(WIDGETS.stat);
    for (const prose of [heading, text, gone]) {
      expect(board.widgets.has(prose.widget.id), prose.widget.id).toBe(false);
    }
    expect(board.widgets.size).toBe(3);
  });

  it("sends the range only for a widget with a clock on a board with time ranges", () => {
    const [line, pie] = cells(
      [{ widget: "line" }, { widget: "pie" }],
      ["P7D", "P30D"]
    );
    const [plain] = cells([{ widget: "line" }]);

    expect(bound(line).data.request).toEqual({
      method: "POST",
      path: "/api/v3/v1/dashboards/board/widgets/line/run",
      body: { bucket: true },
      variables: { range: "range" },
    });
    expect(bound(pie).data.request).toEqual({
      method: "POST",
      path: "/api/v3/v1/dashboards/board/widgets/pie/run",
    });
    expect(pie.widget.description).toBe("All time");
    expect(line.widget).not.toHaveProperty("description");
    expect(bound(plain).data.request).toEqual({
      method: "POST",
      path: "/api/v3/v1/dashboards/board/widgets/line/run",
    });
    expect(plain.widget).not.toHaveProperty("description");
  });

  it("asks for buckets only when the widget draws the bucket column", () => {
    const [bar] = cells([{ widget: "bar" }], ["P7D"]);

    expect(bound(bar).data.request).toMatchObject({ body: { bucket: false } });
  });

  it("gives a stat cell a low frame and every other widget a larger view", () => {
    const [stat] = cells([{ widget: "stat" }]);
    const [line] = cells([{ widget: "line" }]);

    expect(stat).toMatchObject({ size: "medium", height: "low" });
    expect(stat).not.toHaveProperty("larger_view");
    expect(line).toMatchObject({ size: "medium", height: "high" });
    expect(line.larger_view).toMatchObject({
      title: line.widget.title,
      render: line.widget.render,
    });
  });

  it("puts framed cells two in a row, and raises a low cell beside a high one to the high one's height", () => {
    const drawn = cells([
      { widget: "stat" },
      { widget: "line" },
      { widget: "stat" },
      { widget: "stat" },
      { heading: "Next" },
      { widget: "stat" },
      { widget: "gone" },
      { widget: "pie" },
      { widget: "stat" },
    ]);

    expect(drawn.map((cell) => cell.height ?? "frameless")).toEqual([
      "high",
      "high",
      "low",
      "low",
      "frameless",
      "low",
      "low",
      "high",
      "high",
    ]);
  });

  it("leaves a lone low cell at the end of a run low", () => {
    const drawn = cells([
      { widget: "line" },
      { widget: "pie" },
      { widget: "stat" },
    ]);

    expect(drawn.map((cell) => cell.height)).toEqual(["high", "high", "low"]);
  });

  it("writes value labels only on a bar that asks for them, and a legend and a stack only on a bar with a series column", () => {
    const [bar, plain, stacked] = cells([
      { widget: "bar" },
      { widget: "plainBar" },
      { widget: "stacked" },
    ]);

    expect(bar.widget.render).toMatchObject({
      value_labels: "always",
      legend_position: "none",
    });
    expect(plain.widget.render).toMatchObject({
      value_labels: "never",
      legend_position: "none",
    });
    expect(stacked.widget.render).toMatchObject({
      legend_position: "bottom",
      unlisted_stack_group: "outcome",
    });
    expect(stacked.widget.render).not.toHaveProperty("series");
    expect(bar.widget.render).not.toHaveProperty("unlisted_stack_group");
    expect(plain.widget.render).not.toHaveProperty("unlisted_stack_group");
  });

  it("draws every x column on a category axis, as the current chart does, and titles no axis", () => {
    const [line, bar, stacked] = cells([
      { widget: "line" },
      { widget: "bar" },
      { widget: "stacked" },
    ]);

    expect(line.widget.render).toMatchObject({
      x_axis: { type: "category" },
      y_axis: { type: "value" },
    });
    expect(line.widget.render).not.toHaveProperty("drill_down");
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

  it("sizes each table column from its title, so a few short columns fit the cell", () => {
    const board = frontxBoard("board", read([{ widget: "t" }]), [
      widget("t", {
        type: "table",
        metric: "m",
        columns: ["id", "pipeline", "duration_min"],
      }),
    ]);
    const [cell] = dashboardOf(board).layout.cells;
    const { columns } = cell.widget.render as {
      columns: { title: string; width: number }[];
    };

    expect(columns.map(({ title, width }) => [title, width])).toEqual([
      ["id", 62],
      ["pipeline", 104],
      ["duration_min", 132],
    ]);
  });

  it("draws a pie whole, with its legend under it, as the current chart does", () => {
    const [pie] = cells([{ widget: "pie" }]);

    expect(pie.widget.render).toEqual({
      radius: ["80%"],
      legend_position: "bottom",
    });
  });

  it("captions a stat with its label, or with its value column when it has none", () => {
    const board = frontxBoard(
      "board",
      read([{ widget: "a" }, { widget: "b" }]),
      [
        widget("a", { type: "stat", metric: "m", value: "v", label: "runs" }),
        widget("b", { type: "stat", metric: "m", value: "v" }),
      ]
    );
    const [labelled, bare] = dashboardOf(board).layout.cells;

    expect(labelled.widget.render).toEqual({ value_label: "runs" });
    expect(bare.widget.render).toEqual({ value_label: "v" });
  });

  it("titles the board and each widget, and falls back to their names", () => {
    const board = frontxBoard(
      "board",
      read([{ widget: "stat" }, { widget: "line" }]),
      ALL
    );
    const titled = frontxBoard("board", read([], undefined, "Delivery"), ALL);
    const dashboard = dashboardOf(board);

    expect(dashboard).toMatchObject({
      id: board.dashboardId,
      title: "Board name",
      layout: { flexible: false },
    });
    expect(dashboardOf(titled).title).toBe("Delivery");
    expect(dashboard.layout.cells.map((cell) => cell.widget.title)).toEqual([
      "Rate",
      "line name",
    ]);
  });

  it("serves only the board's dashboard: the widget types come with the widget parts", () => {
    const board = frontxBoard("board", read([{ widget: "line" }]), ALL);

    expect(board.dashboardId).toMatch(
      /^gts\.frontx\.dashboard\.dashboard\.dashboard\.v1~[0-9a-f-]{36}$/
    );
    expect(board.file).toEqual({
      types: [],
      instances: [dashboardOf(board)],
    });
    expect(frontxBoard("other", read([]), ALL).dashboardId).not.toBe(
      board.dashboardId
    );
  });
});

const TABLE_OF = (result?: MetricResult): Widget => ({
  type: "table",
  metric: "m",
  columns: result?.columns ?? [],
});

describe("frontxAnswer", () => {
  it("adds each column's position and its distinct values in the order the current stacked chart uses", () => {
    const result: MetricResult = {
      columns: ["team", "outcome", "runs"],
      rows: [
        ["Cobalt", "ok", 3],
        ["Atlas", "failed", 1],
        ["Borealis", "ok", 10],
        ["Atlas", null, null],
      ],
      percents: ["runs"],
    };

    expect(frontxAnswer(result, TABLE_OF(result))).toEqual({
      ...result,
      at: { team: 0, outcome: 1, runs: 2 },
      distinct: {
        team: ["Atlas", "Borealis", "Cobalt"],
        outcome: [null, "failed", "ok"],
        runs: [null, 1, 3, 10],
      },
      shownRows: result.rows,
    });
  });

  it("answers no rows with empty distinct values", () => {
    expect(frontxAnswer({ columns: ["a"], rows: [] }, TABLE_OF())).toEqual({
      columns: ["a"],
      rows: [],
      at: { a: 0 },
      distinct: { a: [] },
      shownRows: [],
    });
  });
});

function drawnData(
  body: Widget,
  percents: string[],
  answer: MetricResult,
  range?: string,
  units?: DashboardWidget["units"]
) {
  const board = frontxBoard(
    "board",
    read([{ widget: "w" }]),
    [{ ...widget("w", body), percents, units }],
    range
  );
  const [cell] = dashboardOf(board).layout.cells;
  const data = compileTransform(bound(cell).data.transform).evaluate({
    response: frontxAnswer(answer, body),
  });

  return { format: cell.widget.value_format, data };
}

describe("frontxBoard data", () => {
  it("passes a table's rows in the order of its columns", () => {
    const table: Widget = {
      type: "table",
      metric: "m",
      columns: ["team", "runs"],
    };
    const answer = {
      columns: ["runs", "team"],
      rows: [
        [4, "Atlas"],
        [null, "Borealis"],
      ],
    };

    expect(drawnData(table, [], answer)).toEqual({
      format: undefined,
      data: {
        rows: [
          ["Atlas", 4],
          ["Borealis", null],
        ],
        total_rows: 2,
      },
    });
  });

  it.each([
    [499, 499],
    [500, 500],
    [650, 500],
  ])(
    "passes a table of %i rows to the grid as its first %i rows, with the count of all its rows",
    (count, shown) => {
      const table: Widget = { type: "table", metric: "m", columns: ["n"] };
      const answer = {
        columns: ["n"],
        rows: Array.from({ length: count }, (_, index) => [index]),
      };
      const { data } = drawnData(table, [], answer) as {
        data: { rows: unknown[][]; total_rows: number };
      };

      expect(data.rows).toHaveLength(shown);
      expect(data.rows.at(-1)).toEqual([shown - 1]);
      expect(data.total_rows).toBe(count);
    }
  );

  it("draws a bar with a series column as one series per value, in the current chart's stack order and names", () => {
    const stacked: Widget = {
      type: "bar",
      metric: "m",
      x: "team",
      y: "runs",
      series: "outcome",
    };
    const answer = {
      columns: ["team", "outcome", "runs"],
      rows: [
        ["Atlas", "ok", 3],
        ["Atlas", "failed", 1],
        ["Borealis", "ok", 2],
        ["Cobalt", "failed", null],
        ["Delta", null, 5],
        ["Ember", 7, 6],
      ],
    };

    expect(drawnData(stacked, [], answer).data).toEqual({
      series: [
        { name: "—", points: [{ x: "Delta", y: 5 }] },
        { name: "7", points: [{ x: "Ember", y: 6 }] },
        {
          name: "failed",
          points: [
            { x: "Atlas", y: 1 },
            { x: "Cobalt", y: null },
          ],
        },
        {
          name: "ok",
          points: [
            { x: "Atlas", y: 3 },
            { x: "Borealis", y: 2 },
          ],
        },
      ],
    });
  });

  it("names the one series of a line or area after its y column", () => {
    const area: Widget = { type: "area", metric: "m", x: "team", y: "open" };
    const answer = { columns: ["team", "open"], rows: [["Atlas", 2]] };

    expect(drawnData(area, [], answer).data).toEqual({
      series: [{ name: "open", points: [{ x: "Atlas", y: 2 }] }],
    });
  });

  it("draws each row of a pie as a slice", () => {
    const pie: Widget = {
      type: "pie",
      metric: "m",
      label: "state",
      value: "n",
    };
    const answer = {
      columns: ["n", "state"],
      rows: [
        [3, "open"],
        [null, "closed"],
      ],
    };

    expect(drawnData(pie, [], answer)).toEqual({
      format: undefined,
      data: {
        slices: [
          { label: "open", value: 3 },
          { label: "closed", value: null },
        ],
      },
    });
  });

  it("fails the transform when the answer lacks a column the widget names", () => {
    const line: Widget = { type: "line", metric: "m", x: "bucket", y: "runs" };

    expect(() =>
      drawnData(line, [], { columns: ["bucket"], rows: [["2026-11-03", 1]] })
    ).toThrow();
  });
});

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

  it.each<[string, Widget]>([
    ["line over buckets", LINE],
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
    expect(xs(STACKED, [])).toEqual([]);
  });
});

describe("frontxBoard percent columns", () => {
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

  it("reads a widgets answer with no percents field as no percent columns", () => {
    const board = frontxBoard("board", read([{ widget: "w" }]), [
      widget("w", STAT),
    ]);
    const [cell] = dashboardOf(board).layout.cells;

    expect(cell.widget).not.toHaveProperty("value_format");
  });

  it.each([
    47.25, 12.25, 10, 9.876, 0.5, 0, 1234, 1_234_567.25, -47.25, -3.125, 1e18,
    -1e18,
  ])("writes the stat %d as the current stat does", (value) => {
    for (const percents of [[], ["rate"]]) {
      const { format, data } = drawnData(STAT, percents, {
        columns: ["rate"],
        rows: [[value]],
      });

      expect(
        formatValue((data as { value: number }).value, format, "en"),
        `${value} with percents ${String(percents)}`
      ).toBe(groupedNumber(value, percents.length > 0 ? "%" : ""));
    }
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
      { series: [{ name: "rate", points: [{ x: "Oct 1", y: 0.5 }] }] },
    ],
    [
      "bar",
      { type: "bar", metric: "m", x: "team", y: "rate" },
      { columns: ["team", "rate"], rows: [["Atlas", 25]] },
      { series: [{ name: "rate", points: [{ x: "Atlas", y: 0.25 }] }] },
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

  it("gives a percent table column a percent format with one decimal and its fraction, and leaves the others", () => {
    const table: Widget = {
      type: "table",
      metric: "m",
      columns: ["team", "rate", "runs"],
    };
    const answer = {
      columns: ["team", "runs", "rate"],
      rows: [
        ["Atlas", 40, 97.5],
        ["Borealis", 12, -2.25],
        ["Cobalt", 3, null],
      ],
    };
    const board = frontxBoard("board", read([{ widget: "w" }]), [
      { ...widget("w", table), percents: ["rate"] },
    ]);
    const [cell] = dashboardOf(board).layout.cells;

    expect(cell.widget.render).toEqual({
      columns: [
        { key: "c0", title: "team", width: 76 },
        {
          key: "c1",
          title: "rate",
          width: 76,
          value_format: { value_type: "percent", decimals: 1 },
        },
        { key: "c2", title: "runs", width: 76 },
      ],
    });
    expect(drawnData(table, ["rate"], answer)).toEqual({
      format: undefined,
      data: {
        rows: [
          ["Atlas", 0.975, 40],
          ["Borealis", -0.0225, 12],
          ["Cobalt", null, 3],
        ],
        total_rows: 3,
      },
    });
  });
});

describe("frontxBoard duration columns", () => {
  const LEAD: Widget = { type: "stat", metric: "m", value: "lead" };
  const MINUTES = {
    value_type: "duration",
    unit: "min",
    compound: true,
  } as const;

  it("shows a duration stat in two parts of its unit, as the number it is", () => {
    const { format, data } = drawnData(
      LEAD,
      [],
      { columns: ["lead"], rows: [[52]] },
      undefined,
      { lead: "h" }
    );

    expect({ format, data }).toEqual({
      format: { value_type: "duration", unit: "h", compound: true },
      data: { value: 52 },
    });
    expect(formatValue(52, format, "en")).toBe("2d 4h");
  });

  it.each<[number, DurationUnit]>([
    [52, "h"],
    [0.0149, "h"],
    [12.345, "h"],
    [90, "s"],
    [59.6, "s"],
    [0.4, "ms"],
    [0.0004, "s"],
    [-2.5, "d"],
    [-0.0001, "s"],
    [0, "min"],
    [125.5, "min"],
    [999.9, "d"],
  ])(
    "writes the duration stat %d %s as the current stat does",
    (value, unit) => {
      const { format, data } = drawnData(
        LEAD,
        [],
        { columns: ["lead"], rows: [[value]] },
        undefined,
        { lead: unit }
      );

      expect(formatValue((data as { value: number }).value, format, "en")).toBe(
        groupedNumber(value, unit)
      );
    }
  );

  it("compares a duration stat with the exact previous value", () => {
    const body: Widget = { ...LEAD, compare: {} };
    const board = frontxBoard("board", read([{ widget: "w" }]), [
      { ...widget("w", body), units: { lead: "h" } },
    ]);
    const [cell] = dashboardOf(board).layout.cells;
    const answer = (value: number) =>
      frontxAnswer({ columns: ["lead"], rows: [[value]] }, body);

    expect(
      compileTransform(bound(cell).data.transform).evaluate({
        response: { ...answer(0.0149), previous: answer(12.345) },
      })
    ).toEqual({ value: 0.0149, reference_value: 12.345 });
  });

  it.each<[string, Widget, MetricResult, unknown]>([
    [
      "line",
      { type: "line", metric: "m", x: "bucket", y: "wait" },
      { columns: ["bucket", "wait"], rows: [["2026-10-01", 50]] },
      { series: [{ name: "wait", points: [{ x: "Oct 1", y: 50 }] }] },
    ],
    [
      "bar with a series column",
      { type: "bar", metric: "m", x: "team", y: "wait", series: "outcome" },
      { columns: ["team", "outcome", "wait"], rows: [["Atlas", "ok", 25]] },
      { series: [{ name: "ok", points: [{ x: "Atlas", y: 25 }] }] },
    ],
    [
      "pie",
      { type: "pie", metric: "m", label: "state", value: "wait" },
      { columns: ["state", "wait"], rows: [["open", 75]] },
      { slices: [{ label: "open", value: 75 }] },
    ],
    [
      "heatmap",
      { type: "heatmap", metric: "m", x: "team", y: "day", value: "wait" },
      { columns: ["team", "day", "wait"], rows: [["Atlas", "Mon", 5]] },
      { rows: [{ x: "Atlas", y: "Mon", value: 5 }] },
    ],
    [
      "treemap",
      { type: "treemap", metric: "m", label: "repo", value: "wait" },
      { columns: ["repo", "wait"], rows: [["api", 9]] },
      { items: [{ label: "api", value: 9, group: null }] },
    ],
  ])(
    "formats a %s duration in its unit and keeps the number",
    (kind, body, answer, data) => {
      expect(
        drawnData(body, [], answer, undefined, { wait: "min" }),
        kind
      ).toEqual({ format: MINUTES, data });
    }
  );

  it("gives a duration table column its unit, and leaves the others", () => {
    const table: Widget = {
      type: "table",
      metric: "m",
      columns: ["team", "wait", "rate"],
    };
    const board = frontxBoard("board", read([{ widget: "w" }]), [
      { ...widget("w", table), percents: ["rate"], units: { wait: "s" } },
    ]);
    const [cell] = dashboardOf(board).layout.cells;

    expect(cell.widget.render).toEqual({
      columns: [
        { key: "c0", title: "team", width: 76 },
        {
          key: "c1",
          title: "wait",
          width: 76,
          value_format: { value_type: "duration", unit: "s", compound: true },
        },
        {
          key: "c2",
          title: "rate",
          width: 76,
          value_format: { value_type: "percent", decimals: 1 },
        },
      ],
    });
    expect(
      drawnData(table, ["rate"], {
        columns: ["team", "wait", "rate"],
        rows: [["Atlas", 340, 12.5]],
      }).data
    ).toEqual({ rows: [["Atlas", 340, 0.125]], total_rows: 1 });
  });

  it.each<[string, DashboardWidget["units"], unknown]>([
    ["every column in one unit", { a: "min", b: "min" }, MINUTES],
    ["columns in two units", { a: "min", b: "h" }, undefined],
    ["one column without a unit", { a: "min" }, undefined],
  ])(
    "shows a funnel and a scatter as durations only for %s",
    (_, units, format) => {
      const funnel: Widget = {
        type: "funnel",
        metric: "m",
        stages: ["a", "b"],
      };
      const scatter: Widget = { type: "scatter", metric: "m", x: "a", y: "b" };
      const answer = { columns: ["a", "b"], rows: [[1, 2]] };

      for (const body of [funnel, scatter]) {
        expect(
          drawnData(body, [], answer, undefined, units).format,
          body.type
        ).toEqual(format);
      }
    }
  );
});

describe("frontxBoard options", () => {
  function renderOf(body: Widget, percents: string[] = []) {
    const board = frontxBoard("board", read([{ widget: "w" }]), [
      { ...widget("w", body), percents },
    ]);
    const [cell] = dashboardOf(board).layout.cells;

    return cell.widget.render;
  }

  const STAT: Widget = { type: "stat", metric: "m", value: "n", label: "runs" };
  const now = { columns: ["n"], rows: [[125]] };

  function compared(
    body: Widget,
    percents: string[],
    previous: FrontxAnswer | null | undefined
  ) {
    const board = frontxBoard("board", read([{ widget: "w" }]), [
      { ...widget("w", body), percents },
    ]);
    const [cell] = dashboardOf(board).layout.cells;
    const answer = frontxAnswer(now, body);

    return compileTransform(bound(cell).data.transform).evaluate({
      response: previous === undefined ? answer : { ...answer, previous },
    });
  }

  it.each<[string, Widget, Record<string, unknown>]>([
    [
      "higher is better by default",
      { ...STAT, compare: {} },
      { better: "higher" },
    ],
    [
      "the direction it names",
      { ...STAT, compare: { better: "lower" } },
      { better: "lower" },
    ],
  ])("compares a stat with the previous period, %s", (_, body, render) => {
    expect(renderOf(body)).toEqual({
      value_label: "runs",
      reference_label: "Previous period",
      ...render,
    });
  });

  it("leaves a stat that does not compare without a reference", () => {
    expect(renderOf(STAT)).toEqual({ value_label: "runs" });
    expect(
      compared(STAT, [], frontxAnswer({ columns: ["n"], rows: [[100]] }, STAT))
    ).toEqual({
      value: 125,
    });
  });

  it.each<[string, string[], FrontxAnswer | null | undefined, unknown]>([
    [
      "the previous run's value",
      [],
      frontxAnswer({ columns: ["n"], rows: [[100]] }, STAT),
      100,
    ],
    [
      "the previous run's fraction on a percent column",
      ["n"],
      frontxAnswer({ columns: ["x", "n"], rows: [[0, 12.5]] }, STAT),
      0.125,
    ],
    ["no reference when the previous run failed", [], null, null],
    ["no reference when the host asked no previous run", [], undefined, null],
    [
      "no reference when the previous period has no rows",
      [],
      frontxAnswer({ columns: ["n"], rows: [] }, STAT),
      null,
    ],
  ])("gives a compared stat %s", (_, percents, previous, reference) => {
    const data = compared({ ...STAT, compare: {} }, percents, previous) as {
      reference_value: unknown;
    };

    expect(data.reference_value).toEqual(reference);
  });

  const BAR: Widget = { type: "bar", metric: "m", x: "team", y: "n" };
  const STACKED: Widget = { ...BAR, series: "outcome" };

  it.each<[string, Widget, string[], Record<string, unknown>]>([
    [
      "a horizontal bar",
      { ...BAR, horizontal: true },
      [],
      { orientation: "horizontal" },
    ],
    [
      "a bar stacked to 100%",
      { ...STACKED, stack: "percent" },
      [],
      { stack_mode: "percent" },
    ],
    [
      "a target on a bar",
      { ...BAR, target: { value: 40, label: "Goal" } },
      [],
      { reference_lines: [{ value: 40, label: "Goal" }] },
    ],
    [
      "a target on a percent bar, as a fraction",
      { ...BAR, target: { value: 15 } },
      ["n"],
      { reference_lines: [{ value: 0.15 }] },
    ],
    [
      "a target on a bar stacked to 100%, as a share",
      { ...STACKED, stack: "percent", target: { value: 15 } },
      [],
      { stack_mode: "percent", reference_lines: [{ value: 0.15 }] },
    ],
    [
      "a target on a line",
      {
        type: "line",
        metric: "m",
        x: "bucket",
        y: "n",
        target: { value: 3 },
      },
      [],
      { reference_lines: [{ value: 3 }] },
    ],
    [
      "a target on an area",
      {
        type: "area",
        metric: "m",
        x: "bucket",
        y: "n",
        target: { value: 3 },
      },
      [],
      { reference_lines: [{ value: 3 }] },
    ],
  ])("draws %s", (_, body, percents, expected) => {
    expect(renderOf(body, percents)).toMatchObject(expected);
  });

  it("draws no orientation, stack mode or line that the widget does not ask for", () => {
    for (const body of [BAR, STACKED, { ...BAR, stack: "percent" } as Widget]) {
      const render = renderOf(body);
      expect(render, JSON.stringify(body)).not.toHaveProperty("orientation");
      expect(render, JSON.stringify(body)).not.toHaveProperty("stack_mode");
      expect(render, JSON.stringify(body)).not.toHaveProperty(
        "reference_lines"
      );
    }
  });

  it("draws an area by series as areas stacked by that column, one series per value", () => {
    const body: Widget = {
      type: "area",
      metric: "m",
      x: "team",
      y: "n",
      series: "outcome",
    };
    const answer = {
      columns: ["team", "outcome", "n"],
      rows: [
        ["Atlas", "ok", 3],
        ["Atlas", "failed", 1],
      ],
    };

    expect(renderOf(body)).toEqual({
      legend_position: "bottom",
      unlisted_type: "area",
      unlisted_stack_group: "outcome",
      x_axis: { type: "category" },
      y_axis: { type: "value" },
    });
    expect(drawnData(body, [], answer).data).toEqual({
      series: [
        { name: "failed", points: [{ x: "Atlas", y: 1 }] },
        { name: "ok", points: [{ x: "Atlas", y: 3 }] },
      ],
    });
  });

  it("draws a line by series as one unstacked line per value, with its target", () => {
    const body: Widget = {
      type: "line",
      metric: "m",
      x: "team",
      y: "n",
      series: "outcome",
      target: { value: 2 },
    };
    const answer = {
      columns: ["team", "outcome", "n"],
      rows: [
        ["Atlas", "ok", 3],
        ["Atlas", "failed", 1],
        ["Borealis", "ok", null],
      ],
    };

    expect(renderOf(body)).toEqual({
      legend_position: "bottom",
      unlisted_type: "line",
      reference_lines: [{ value: 2 }],
      x_axis: { type: "category" },
      y_axis: { type: "value" },
    });
    expect(drawnData(body, [], answer).data).toEqual({
      series: [
        { name: "failed", points: [{ x: "Atlas", y: 1 }] },
        {
          name: "ok",
          points: [
            { x: "Atlas", y: 3 },
            { x: "Borealis", y: null },
          ],
        },
      ],
    });
  });
});

describe("frontxBoard new types", () => {
  function cellOf(body: Widget, range?: string) {
    const board = frontxBoard(
      "board",
      read([{ widget: "w" }]),
      [widget("w", body)],
      range
    );
    return dashboardOf(board).layout.cells[0];
  }

  const typeOf = (cell: ReturnType<typeof cellOf>) =>
    /\.widget\.([a-z_]+)\.v1~[0-9a-f-]{36}$/.exec(cell.widget.id)?.[1];

  const MATRIX: Widget = {
    type: "heatmap",
    metric: "m",
    x: "bucket",
    y: "team",
    value: "n",
  };
  const CALENDAR: Widget = {
    type: "heatmap",
    metric: "m",
    x: "bucket",
    value: "n",
  };
  const FUNNEL: Widget = {
    type: "funnel",
    metric: "m",
    stages: ["opened", "reviewed", "merged"],
  };
  const TREEMAP: Widget = {
    type: "treemap",
    metric: "m",
    label: "repo",
    value: "n",
  };
  const SCATTER: Widget = {
    type: "scatter",
    metric: "m",
    x: "size",
    y: "hours",
  };

  it.each<[string, Widget, string | undefined, string]>([
    ["a heatmap with a y column", MATRIX, "PQC", "heatmap"],
    ["a calendar heatmap over daily buckets", CALENDAR, "P30D", "heatmap"],
    [
      "a calendar heatmap over wider buckets",
      CALENDAR,
      "PQC",
      "cartesian_chart",
    ],
    [
      "a calendar heatmap with no range",
      CALENDAR,
      undefined,
      "cartesian_chart",
    ],
    ["a funnel", FUNNEL, undefined, "funnel_chart"],
    ["a treemap", TREEMAP, undefined, "treemap_chart"],
    ["a scatter", SCATTER, undefined, "cartesian_chart"],
  ])("draws %s as a FrontX %s", (_, body, range, type) => {
    expect(typeOf(cellOf(body, range))).toBe(type);
  });

  it("draws a heatmap with a y column as a matrix of x by y", () => {
    const answer = {
      columns: ["bucket", "team", "n"],
      rows: [
        ["2026-11-03 00:00:00", "Atlas", 4],
        ["2026-11-04", "Borealis", null],
      ],
    };

    expect(cellOf(MATRIX, "PQC").widget.render).toEqual({});
    expect(drawnData(MATRIX, [], answer, "PQC")).toEqual({
      format: undefined,
      data: {
        rows: [
          { x: "Nov 3", y: "Atlas", value: 4 },
          { x: "Nov 4", y: "Borealis", value: null },
        ],
      },
    });
  });

  it("draws a calendar heatmap over daily buckets with one tile per dated row, as a fraction on a percent column", () => {
    const answer = {
      columns: ["bucket", "n"],
      rows: [
        ["2026-11-03 00:00:00", 40],
        ["2026-11-04", 12.5],
        [null, 3],
        ["team", 3],
      ],
    };

    expect(cellOf(CALENDAR, "P30D").widget.render).toEqual({
      mode: "calendar",
    });
    expect(drawnData(CALENDAR, ["n"], answer, "P30D")).toEqual({
      format: { value_type: "percent" },
      data: {
        rows: [
          { x: "2026-11-03", value: 0.4 },
          { x: "2026-11-04", value: 0.125 },
        ],
      },
    });
  });

  it("draws a calendar heatmap over wider buckets as bars over time", () => {
    const answer = {
      columns: ["bucket", "n"],
      rows: [["2026-11-02 00:00:00", 9]],
    };

    expect(cellOf(CALENDAR, "PQC").widget.render).toMatchObject({
      series: [{ name: "n", type: "bar" }],
      x_axis: { type: "category" },
    });
    expect(drawnData(CALENDAR, [], answer, "PQC").data).toEqual({
      series: [{ name: "n", points: [{ x: "Nov 2", y: 9 }] }],
    });
  });

  it("draws each listed column of a funnel's one row as a stage, in the listed order", () => {
    const answer = {
      columns: ["merged", "opened", "reviewed"],
      rows: [[30, 100, null]],
    };

    expect(drawnData(FUNNEL, [], answer).data).toEqual({
      stages: [
        { label: "opened", value: 100 },
        { label: "reviewed", value: null },
        { label: "merged", value: 30 },
      ],
    });
    expect(
      drawnData(FUNNEL, [], { columns: answer.columns, rows: [] }).data
    ).toEqual({
      stages: [
        { label: "opened", value: null },
        { label: "reviewed", value: null },
        { label: "merged", value: null },
      ],
    });
  });

  it("shows a funnel in percents only when every stage is a percent column", () => {
    const answer = {
      columns: ["opened", "reviewed", "merged"],
      rows: [[90, 50, 25]],
    };

    expect(
      drawnData(FUNNEL, ["opened", "reviewed", "merged"], answer)
    ).toMatchObject({
      format: { value_type: "percent" },
      data: { stages: [{ value: 0.9 }, { value: 0.5 }, { value: 0.25 }] },
    });
    expect(drawnData(FUNNEL, ["opened"], answer).format).toBeUndefined();
  });

  it("draws the 60 largest rows of a treemap, largest first, each named and in its group", () => {
    const rows = Array.from({ length: 70 }, (_, index) => [
      `repo-${index}`,
      index,
      index % 2 ? "web" : null,
    ]);
    const body: Widget = { ...TREEMAP, group: "area" };
    const { data } = drawnData(body, [], {
      columns: ["repo", "n", "area"],
      rows,
    }) as {
      data: { items: { label: string; value: number; group: unknown }[] };
    };

    expect(data.items).toHaveLength(60);
    expect(data.items[0]).toEqual({
      label: "repo-69",
      value: 69,
      group: "web",
    });
    expect(data.items[1]).toEqual({ label: "repo-68", value: 68, group: null });
    expect(data.items.at(-1)?.value).toBe(10);
  });

  it("names a treemap tile with no name by a dash, and cuts a long name and group", () => {
    const body: Widget = { ...TREEMAP, group: "area" };
    const { data } = drawnData(body, [], {
      columns: ["repo", "n", "area"],
      rows: [
        [null, 3, ""],
        ["", 2, "g".repeat(41)],
        ["r".repeat(81), 1, "web"],
      ],
    }) as { data: { items: { label: string; group: unknown }[] } };

    expect(data.items.map((item) => [item.label, item.group])).toEqual([
      ["—", null],
      ["—", `${"g".repeat(39)}…`],
      [`${"r".repeat(79)}…`, "web"],
    ]);
  });

  it("draws a treemap with no rows as one empty tile, which FrontX shows as empty", () => {
    expect(
      drawnData(TREEMAP, [], { columns: ["repo", "n"], rows: [] }).data
    ).toEqual({ items: [{ label: "—", value: null, group: null }] });
  });

  it("draws a scatter on value axes, with a named point for each row that has both coordinates", () => {
    const body: Widget = { ...SCATTER, size: "comments", label: "pr" };
    const answer = {
      columns: ["pr", "size", "hours", "comments"],
      rows: [
        ["pr-1", 120, 5.5, 3],
        [7, "40", 2, -1],
        ["pr-3", null, 1, 2],
        [null, 10, 1, null],
      ],
    };

    expect(cellOf(body).widget.render).toEqual({
      series: [{ name: "hours", type: "scatter" }],
      x_axis: { type: "value" },
      y_axis: { type: "value" },
      legend_position: "none",
      size_label: "comments",
    });
    expect(drawnData(body, [], answer).data).toEqual({
      series: [
        {
          name: "hours",
          points: [
            { x: 120, y: 5.5, size: 3, label: "pr-1" },
            { x: 40, y: 2, size: 0, label: "7" },
            { x: 10, y: 1, size: null, label: "—" },
          ],
        },
      ],
    });
  });

  it("draws a scatter on two percent columns as fractions", () => {
    const answer = { columns: ["size", "hours"], rows: [[40, 12.5]] };

    expect(drawnData(SCATTER, ["size", "hours"], answer)).toEqual({
      format: { value_type: "percent" },
      data: { series: [{ name: "hours", points: [{ x: 0.4, y: 0.125 }] }] },
    });
  });

  it("draws a scatter by series as one scatter series per value that has a point, in the current chart's order", () => {
    const body: Widget = { ...SCATTER, series: "team" };
    const answer = {
      columns: ["size", "hours", "team"],
      rows: [
        [120, 5.5, "web"],
        [40, 2, "api"],
        [10, 1, null],
        [30, null, "docs"],
        [20, 3, "api"],
      ],
    };

    expect(cellOf(body).widget.render).toEqual({
      unlisted_type: "scatter",
      x_axis: { type: "value" },
      y_axis: { type: "value" },
      legend_position: "bottom",
    });
    expect(drawnData(body, [], answer).data).toEqual({
      series: [
        { name: "—", points: [{ x: 10, y: 1 }] },
        {
          name: "api",
          points: [
            { x: 40, y: 2 },
            { x: 20, y: 3 },
          ],
        },
        { name: "web", points: [{ x: 120, y: 5.5 }] },
      ],
    });
  });
});
