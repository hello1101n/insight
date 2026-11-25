import type { Dashboard as FrontxDashboard } from "@gears-frontx/frontx-dashboard-root/contract";
import { describe, expect, it } from "vitest";

import type {
  DashboardItem,
  DashboardRead,
  DashboardWidget,
  MetricResult,
  Widget,
} from "@/api/custom-client";
import { groupedNumber } from "@/components/custom/chart-format";
import { frontxAnswer, frontxBoard } from "@/lib/custom/frontx-board";

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

  it("reads a date bucket on the x axis as time, any other column as a category, and titles no axis", () => {
    const [line, bar, stacked] = cells([
      { widget: "line" },
      { widget: "bar" },
      { widget: "stacked" },
    ]);

    expect(line.widget.render).toMatchObject({
      x_axis: { type: "time" },
      y_axis: { type: "value" },
      drill_down: true,
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

    expect(frontxAnswer(result)).toEqual({
      ...result,
      at: { team: 0, outcome: 1, runs: 2 },
      distinct: {
        team: ["Atlas", "Borealis", "Cobalt"],
        outcome: [null, "failed", "ok"],
        runs: [null, 1, 3, 10],
      },
      tableRows: result.rows,
    });
  });

  it("answers no rows with empty distinct values", () => {
    expect(frontxAnswer({ columns: ["a"], rows: [] })).toEqual({
      columns: ["a"],
      rows: [],
      at: { a: 0 },
      distinct: { a: [] },
      tableRows: [],
    });
  });
});

function drawnData(body: Widget, percents: string[], answer: MetricResult) {
  const board = frontxBoard("board", read([{ widget: "w" }]), [
    { ...widget("w", body), percents },
  ]);
  const [cell] = dashboardOf(board).layout.cells;
  const data = compileTransform(bound(cell).data.transform).evaluate({
    response: frontxAnswer(answer),
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

  it("draws a bar with a series column as one series per value, in the current chart's stack order", () => {
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
        { name: null, points: [{ x: "Delta", y: 5 }] },
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

  it.each<[string, unknown, unknown]>([
    ["a date-time", "2026-11-03 00:00:00", "2026-11-03T00:00:00Z"],
    ["an hour bucket", "2026-11-03 14:00:00", "2026-11-03T14:00:00Z"],
    [
      "fractional seconds",
      "2026-11-03 00:00:00.000",
      "2026-11-03T00:00:00.000Z",
    ],
    ["a date", "2026-11-03", "2026-11-03"],
    ["an ISO date-time", "2026-11-03T00:00:00Z", "2026-11-03T00:00:00Z"],
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
      { series: [{ name: "rate", points: [{ x: "2026-10-01", y: 0.5 }] }] },
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
        { key: "c0", title: "team" },
        {
          key: "c1",
          title: "rate",
          value_format: { value_type: "percent", decimals: 1 },
        },
        { key: "c2", title: "runs" },
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
