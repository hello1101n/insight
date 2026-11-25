import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const role = vi.hoisted(() => ({ isAdmin: false, isPending: true }));
vi.mock("@/queries/identity-me", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/queries/identity-me")>()),
  useIsAdmin: () => ({ ...role, isError: false, retry: () => {} }),
}));

vi.mock("@/api/custom-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/custom-client")>();
  return {
    ...actual,
    fetchMetric: vi.fn(async () => ({
      name: "Lines per day",
      definition: { table: "commits", fields: [] },
    })),
  };
});

// WORKAROUND: recharts draws nothing in jsdom's zero-size ResponsiveContainer.
// Partial, since the kit's chart container imports recharts pieces a bare mock hides.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();

  const chart =
    (testId: string) =>
    ({
      data,
      onClick,
      layout,
      stackOffset,
      children,
    }: {
      data?: Record<string, unknown>[];
      onClick?: (state: { activeTooltipIndex: number | null }) => void;
      layout?: string;
      stackOffset?: string;
      children: React.ReactNode;
    }) => (
      <div
        data-testid={testId}
        data-chart-data={JSON.stringify(data ?? null)}
        data-layout={layout}
        data-stack-offset={stackOffset}
      >
        {(data ?? []).map((_, index) => (
          <button
            key={index}
            type="button"
            aria-label={`${testId} point ${index}`}
            onClick={() => onClick?.({ activeTooltipIndex: index })}
          />
        ))}
        <button
          type="button"
          aria-label={`${testId} between points`}
          onClick={() => onClick?.({ activeTooltipIndex: null })}
        />
        {children}
      </div>
    );
  const series =
    (testId: string) =>
    ({
      dataKey,
      name,
      stackId,
      children,
    }: {
      dataKey: string;
      name?: string;
      stackId?: string;
      children?: React.ReactNode;
    }) => (
      <div
        data-testid={testId}
        data-key={dataKey}
        data-name={name}
        data-stack-id={stackId}
      >
        {children}
      </div>
    );

  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    LineChart: chart("line-chart"),
    BarChart: chart("bar-chart"),
    AreaChart: chart("area-chart"),
    PieChart: chart("pie-chart"),
    CartesianGrid: () => null,
    Tooltip: () => null,
    Legend: ({
      itemSorter,
      content,
    }: {
      itemSorter?: unknown;
      content?: React.ReactElement<{ className?: string }>;
    }) => (
      <div
        data-testid="legend"
        data-item-sorter={String(itemSorter)}
        data-content-class={content?.props.className}
      />
    ),
    LabelList: ({ dataKey }: { dataKey: string }) => (
      <div data-testid="label-list" data-key={dataKey} />
    ),
    XAxis: ({ dataKey }: { dataKey: string }) => (
      <div data-testid="x-axis" data-key={dataKey} />
    ),
    YAxis: () => null,
    ReferenceLine: ({
      x,
      y,
      label,
    }: {
      x?: number;
      y?: number;
      label?: { value: string };
    }) => (
      <div
        data-testid="target"
        data-x={x}
        data-y={y}
        data-label={label?.value}
      />
    ),
    Line: series("line"),
    Bar: series("bar"),
    Area: series("area"),
    Pie: ({
      data,
      dataKey,
      nameKey,
      onClick,
      children,
    }: {
      data?: Record<string, unknown>[];
      dataKey: string;
      nameKey: string;
      onClick?: (slice: { name: unknown }) => void;
      children: React.ReactNode;
    }) => (
      <div data-testid="pie" data-key={dataKey} data-name-key={nameKey}>
        {(data ?? []).map((slice, index) => (
          <button
            key={index}
            type="button"
            aria-label={`slice ${String(slice[nameKey])}`}
            onClick={() => onClick?.({ name: slice[nameKey] })}
          />
        ))}
        {children}
      </div>
    ),
    Cell: () => null,
  };
});

import { CustomApiError, type Widget } from "@/api/custom-client";
import { wrapper } from "@/test/alerts";

import { CustomWidget } from "./custom-widget";

const result = {
  columns: ["day", "lines"],
  rows: [
    ["2026-09-01", 59],
    ["2026-09-02", 12],
  ],
};

describe("<CustomWidget>", () => {
  it("renders a table widget as rows", () => {
    render(
      <CustomWidget
        widget={{ type: "table", metric: "m", columns: ["day", "lines"] }}
        result={result}
      />
    );

    expect(
      screen.getByRole("columnheader", { name: "day" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("says the widget type is unknown for a type it does not draw", () => {
    render(
      <CustomWidget
        widget={{ type: "sankey", metric: "m" } as unknown as Widget}
        result={result}
      />
    );

    expect(screen.getByText("Unknown widget type.")).toBeInTheDocument();
  });

  it("renders a line widget as a chart", () => {
    render(
      <CustomWidget
        widget={{ type: "line", metric: "m", x: "day", y: "lines" }}
        result={result}
      />
    );

    expect(screen.getByTestId("custom-line-chart")).toBeInTheDocument();
  });

  it.each([
    ["line", { type: "line", metric: "m", x: "day", y: "lines" }],
    ["bar", { type: "bar", metric: "m", x: "day", y: "lines" }],
    ["area", { type: "area", metric: "m", x: "day", y: "lines" }],
    ["pie", { type: "pie", metric: "m", label: "day", value: "lines" }],
  ] as const)(
    "draws a %s chart at the card's height unless asked to fill its container",
    (kind, widget: Widget) => {
      const { rerender } = render(
        <CustomWidget widget={widget} result={result} />
      );
      expect(screen.getByTestId(`custom-${kind}-chart`), kind).toHaveClass(
        "h-64"
      );

      rerender(<CustomWidget widget={widget} result={result} fillHeight />);
      expect(screen.getByTestId(`custom-${kind}-chart`), kind).toHaveClass(
        "h-full"
      );
    }
  );

  it.each([
    ["line", { type: "line", metric: "m", x: "day", y: "lines" }],
    ["bar", { type: "bar", metric: "m", x: "day", y: "lines" }],
    ["area", { type: "area", metric: "m", x: "day", y: "lines" }],
  ] as const)(
    "reports a click on a %s chart's point, and none between points",
    (kind, widget: Widget) => {
      const onPointClick = vi.fn();
      render(
        <CustomWidget
          widget={widget}
          result={result}
          onPointClick={onPointClick}
        />
      );

      fireEvent.click(
        screen.getByRole("button", { name: `${kind}-chart point 1` })
      );
      fireEvent.click(
        screen.getByRole("button", { name: `${kind}-chart between points` })
      );

      expect(onPointClick, kind).toHaveBeenCalledTimes(1);
    }
  );

  it("reports a click on a pie's slice", () => {
    const onPointClick = vi.fn();
    render(
      <CustomWidget
        widget={{ type: "pie", metric: "m", label: "day", value: "lines" }}
        result={result}
        onPointClick={onPointClick}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "slice 2026-09-01" }));

    expect(onPointClick).toHaveBeenCalledTimes(1);
  });

  it("maps the widget's x and y fields to the chart axes and row values", () => {
    render(
      <CustomWidget
        widget={{ type: "line", metric: "m", x: "day", y: "lines" }}
        result={result}
      />
    );

    expect(screen.getByTestId("x-axis")).toHaveAttribute("data-key", "day");
    expect(screen.getByTestId("line")).toHaveAttribute("data-key", "lines");

    const chartData = JSON.parse(
      screen.getByTestId("line-chart").getAttribute("data-chart-data")!
    );
    expect(chartData).toEqual([
      { day: "2026-09-01", lines: 59 },
      { day: "2026-09-02", lines: 12 },
    ]);
  });

  it("shows the service's refusal in place of the content", () => {
    render(
      <CustomWidget
        widget={{ type: "table", metric: "m", columns: ["day"] }}
        error={
          new CustomApiError(400, {
            detail: "a metric reads a dataset, so it may not name a `table`",
          })
        }
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "a metric reads a dataset, so it may not name a `table`"
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("400");
  });

  it("says the service is busy and offers another try when a run is turned away", async () => {
    const onRetry = vi.fn();
    render(
      <CustomWidget
        widget={{ type: "table", metric: "m", columns: ["day"] }}
        error={new CustomApiError(429, { detail: "every slot is taken" })}
        onRetry={onRetry}
      />
    );

    expect(screen.getByRole("status")).toHaveAccessibleName("Busy, try again.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  });

  it("waits rather than repeating busy while another try is in flight", () => {
    render(
      <CustomWidget
        widget={{ type: "table", metric: "m", columns: ["day"] }}
        error={new CustomApiError(429, null)}
        pending
      />
    );

    expect(screen.queryByText("Busy, try again.")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
  });

  it("says plainly when the failure carries nothing readable", () => {
    render(
      <CustomWidget
        widget={{ type: "table", metric: "m", columns: ["day"] }}
        error={new TypeError("Failed to fetch")}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The metric could not be run."
    );
  });

  it("says there is no data when the metric returned no rows", () => {
    render(
      <CustomWidget
        widget={{ type: "table", metric: "m", columns: ["day"] }}
        result={{ columns: ["day"], rows: [] }}
      />
    );

    expect(screen.getByText(/no data/i)).toBeInTheDocument();
  });

  it("says so when the type is unknown", () => {
    render(
      <CustomWidget
        widget={{ type: "sankey", metric: "m" } as never}
        result={result}
      />
    );

    expect(screen.getByText(/unknown widget type/i)).toBeInTheDocument();
  });

  it("waits rather than saying there is no data while the run is in flight", () => {
    const { rerender } = render(
      <CustomWidget
        widget={{ type: "table", metric: "m", columns: ["day"] }}
        pending
      />
    );

    expect(screen.queryByText(/no data/i)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();

    rerender(
      <CustomWidget widget={{ type: "table", metric: "m", columns: ["day"] }} />
    );

    expect(screen.queryByText(/no data/i)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("pads a short row with empty cells instead of misaligning columns", () => {
    render(
      <CustomWidget
        widget={{
          type: "table",
          metric: "m",
          columns: ["day", "lines", "extra"],
        }}
        result={{
          columns: ["day", "lines", "extra"],
          rows: [["2026-09-01", 59]],
        }}
      />
    );

    const cells = screen.getAllByRole("cell");
    expect(cells).toHaveLength(4);
    expect(cells[1]).toHaveTextContent("2026-09-01");
    expect(cells[2]).toHaveTextContent("59");
    expect(cells[3]).toHaveTextContent("");
  });

  it("does not spill a long row past the declared columns", () => {
    render(
      <CustomWidget
        widget={{ type: "table", metric: "m", columns: ["day"] }}
        result={{ columns: ["day"], rows: [["2026-09-01", 59, "extra"]] }}
      />
    );

    const cells = screen.getAllByRole("cell");
    expect(cells).toHaveLength(2);
    expect(cells[1]).toHaveTextContent("2026-09-01");
  });

  it.each([
    ["bar", "custom-bar-chart", "bar"],
    ["area", "custom-area-chart", "area"],
  ])("renders a %s widget from its x and y", (type, frame, series) => {
    render(
      <CustomWidget
        widget={{ type, metric: "m", x: "day", y: "lines" } as never}
        result={result}
      />
    );

    expect(screen.getByTestId(frame)).toBeInTheDocument();
    expect(screen.getByTestId("x-axis")).toHaveAttribute("data-key", "day");
    expect(screen.getByTestId(series)).toHaveAttribute("data-key", "lines");
  });

  describe("a stacked bar", () => {
    const runs = {
      columns: ["week", "outcome", "runs"],
      rows: [
        ["2026-11-02", "merged", 3],
        ["2026-11-02", "failed", 1],
        ["2026-11-09", "merged", 2],
      ],
    };
    const stacked = {
      type: "bar",
      metric: "m",
      x: "week",
      y: "runs",
      series: "outcome",
    } as const;

    it("draws one segment per series value, all in one stack", () => {
      render(<CustomWidget widget={stacked} result={runs} />);

      const segments = screen.getAllByTestId("bar");
      expect(segments.map((bar) => bar.dataset.name)).toEqual([
        "failed",
        "merged",
      ]);
      expect(new Set(segments.map((bar) => bar.dataset.stackId)).size).toBe(1);
      expect(segments[0].dataset.stackId).toBeTruthy();
      expect(screen.getByTestId("legend")).toBeInTheDocument();
    });

    it("lists the legend in stack order rather than alphabetically", () => {
      render(<CustomWidget widget={stacked} result={runs} />);

      expect(screen.getByTestId("legend")).toHaveAttribute(
        "data-item-sorter",
        "null"
      );
    });

    it("can label a stack's total on whichever segment ends up on top", () => {
      render(
        <CustomWidget widget={{ ...stacked, labels: true }} result={runs} />
      );

      for (const segment of screen.getAllByTestId("bar")) {
        expect(
          segment.querySelector('[data-testid="label-list"]')
        ).not.toBeNull();
      }
    });

    it("wraps a long legend rather than clipping it", () => {
      render(<CustomWidget widget={stacked} result={runs} />);

      expect(screen.getByTestId("legend").dataset.contentClass).toContain(
        "flex-wrap"
      );
    });

    it("draws no labels unless asked", () => {
      render(<CustomWidget widget={stacked} result={runs} />);

      expect(screen.queryByTestId("label-list")).not.toBeInTheDocument();
    });

    it("names a series column the metric did not return", () => {
      render(
        <CustomWidget widget={{ ...stacked, series: "cause" }} result={runs} />,
        { wrapper }
      );

      expect(screen.getByRole("alert")).toHaveTextContent("draws cause");
      expect(screen.queryByTestId("custom-bar-chart")).not.toBeInTheDocument();
    });
  });

  it("labels a plain bar's value on top when asked", () => {
    render(
      <CustomWidget
        widget={{
          type: "bar",
          metric: "m",
          x: "day",
          y: "lines",
          labels: true,
        }}
        result={result}
      />
    );

    expect(screen.getByTestId("label-list")).toHaveAttribute(
      "data-key",
      "lines"
    );
    expect(screen.queryByTestId("legend")).not.toBeInTheDocument();
  });

  it("renders a stat widget as the one number it is", () => {
    render(
      <CustomWidget
        widget={{ type: "stat", metric: "m", value: "lines", label: "Lines" }}
        result={{ columns: ["lines"], rows: [[24887]] }}
      />
    );

    expect(screen.getByTestId("custom-stat")).toHaveTextContent("24,887");
    expect(screen.getByTestId("custom-stat")).toHaveTextContent("Lines");
  });

  it("falls back to the column name when a stat carries no label", () => {
    render(
      <CustomWidget
        widget={{ type: "stat", metric: "m", value: "lines" }}
        result={{ columns: ["lines"], rows: [[7]] }}
      />
    );

    expect(screen.getByTestId("custom-stat")).toHaveTextContent("lines");
  });

  it("renders a pie widget as slices of its value", () => {
    render(
      <CustomWidget
        widget={{ type: "pie", metric: "m", label: "day", value: "lines" }}
        result={result}
      />
    );

    expect(screen.getByTestId("custom-pie-chart")).toBeInTheDocument();
    expect(screen.getByTestId("pie")).toHaveAttribute("data-key", "lines");
    expect(screen.getByTestId("pie")).toHaveAttribute("data-name-key", "day");
  });

  it.each([
    [
      { type: "bar", metric: "lines_per_day", x: "day", y: "lines" },
      "custom-bar-chart",
    ],
    [
      { type: "area", metric: "lines_per_day", x: "day", y: "lines" },
      "custom-area-chart",
    ],
    [{ type: "stat", metric: "lines_per_day", value: "lines" }, "custom-stat"],
    [
      { type: "pie", metric: "lines_per_day", label: "day", value: "lines" },
      "custom-pie-chart",
    ],
  ])("names the missing column rather than drawing %#", (widget, frame) => {
    render(
      <CustomWidget
        widget={widget as never}
        result={{
          columns: ["day", "total_lines"],
          rows: [["2026-09-01", 132]],
        }}
      />,
      { wrapper }
    );

    expect(screen.getByRole("alert")).toHaveTextContent("draws lines");
    expect(screen.queryByTestId(frame)).not.toBeInTheDocument();
  });

  it("says which column is missing instead of drawing an empty chart", async () => {
    render(
      <CustomWidget
        widget={{ type: "line", metric: "lines_per_day", x: "day", y: "lines" }}
        result={{
          columns: ["day", "total_lines"],
          rows: [["2026-09-01", 132]],
        }}
      />,
      { wrapper }
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("draws lines");
    await waitFor(() =>
      expect(alert).toHaveTextContent("Lines per day does not return")
    );
    expect(alert).toHaveTextContent("day, total_lines");
    expect(screen.queryByTestId("custom-line-chart")).not.toBeInTheDocument();
  });

  describe("for a member", () => {
    afterEach(() => {
      role.isPending = true;
    });

    it("says only that the widget cannot be drawn", () => {
      role.isPending = false;
      render(
        <CustomWidget
          widget={{
            type: "line",
            metric: "lines_per_day",
            x: "day",
            y: "lines",
          }}
          result={{
            columns: ["day", "total_lines"],
            rows: [["2026-09-01", 132]],
          }}
        />,
        { wrapper }
      );

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Couldn't draw this widget."
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent("total_lines");
    });

    it("hides the service's refusal behind a generic failure with a retry", () => {
      role.isPending = false;
      const onRetry = vi.fn();
      render(
        <CustomWidget
          widget={{ type: "table", metric: "m", columns: ["day"] }}
          error={
            new CustomApiError(400, {
              detail: "a metric reads a dataset, so it may not name a `table`",
            })
          }
          onRetry={onRetry}
        />
      );

      expect(
        screen.getByText("This widget couldn't be loaded.")
      ).toBeInTheDocument();
      expect(screen.queryByText(/may not name a `table`/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
      expect(onRetry).toHaveBeenCalled();
    });
  });
});

describe("<CustomWidget> over a window that holds nothing", () => {
  it("says the window is empty rather than only that data is missing", () => {
    render(
      <CustomWidget
        widget={{ type: "line", metric: "opened", x: "bucket", y: "opened" }}
        result={{ columns: ["bucket", "opened"], rows: [] }}
        windowed
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /nothing in this window/i
    );
  });

  it("says only that there is no data when no window was asked for", () => {
    render(
      <CustomWidget
        widget={{
          type: "stat",
          metric: "total",
          value: "total",
          label: "Total",
        }}
        result={{ columns: ["total"], rows: [] }}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(/no data/i);
  });
});

describe("<CustomWidget> options", () => {
  const figure = (value: number | null, percents: string[] = []) => ({
    columns: ["n"],
    rows: [[value]],
    percents,
  });
  const STAT: Widget = { type: "stat", metric: "m", value: "n" };

  it.each<[string, Widget, number, number, string[], string, string]>([
    [
      "a rise where higher is better",
      { ...STAT, compare: {} },
      125,
      100,
      [],
      "+25% since the previous period",
      "text-success",
    ],
    [
      "a rise where lower is better",
      { ...STAT, compare: { better: "lower" } },
      125,
      100,
      [],
      "+25% since the previous period",
      "text-destructive",
    ],
    [
      "a rise where neither direction is better",
      { ...STAT, compare: { better: "neutral" } },
      125,
      100,
      [],
      "+25% since the previous period",
      "text-muted-foreground",
    ],
    [
      "a fall on a percent column, in percentage points",
      { ...STAT, compare: {} },
      12,
      15,
      ["n"],
      "-3 pp since the previous period",
      "text-destructive",
    ],
  ])(
    "shows the change of a compared stat for %s",
    (_, widget, now, before, percents, text, tone) => {
      render(
        <CustomWidget
          widget={widget}
          result={figure(now, percents)}
          previous={figure(before, percents)}
        />
      );

      const change = screen.getByText(/since the previous period/);
      expect(change).toHaveTextContent(text);
      expect(change).toHaveClass(tone);
    }
  );

  it.each<[string, Widget, ReturnType<typeof figure> | undefined]>([
    ["a stat that does not compare", STAT, figure(100)],
    [
      "a compared stat with no previous run",
      { ...STAT, compare: {} },
      undefined,
    ],
    [
      "a compared stat whose previous period has no value",
      { ...STAT, compare: {} },
      figure(null),
    ],
  ])("shows no change for %s", (_, widget, previous) => {
    render(
      <CustomWidget widget={widget} result={figure(125)} previous={previous} />
    );

    expect(screen.getByText("125")).toBeInTheDocument();
    expect(
      screen.queryByText(/since the previous period/)
    ).not.toBeInTheDocument();
  });

  const BY_TEAM = {
    columns: ["team", "outcome", "n"],
    rows: [
      ["Atlas", "ok", 3],
      ["Atlas", "failed", 1],
      ["Borealis", "ok", 2],
    ],
  };
  const chartOf = (testId: string) => screen.getByTestId(testId);

  it("draws a horizontal bar with the categories on the side", () => {
    render(
      <CustomWidget
        widget={{
          type: "bar",
          metric: "m",
          x: "team",
          y: "n",
          horizontal: true,
        }}
        result={BY_TEAM}
      />
    );

    expect(chartOf("bar-chart")).toHaveAttribute("data-layout", "vertical");
  });

  it("draws a vertical bar unless asked otherwise", () => {
    render(
      <CustomWidget
        widget={{ type: "bar", metric: "m", x: "team", y: "n" }}
        result={BY_TEAM}
      />
    );

    expect(chartOf("bar-chart")).toHaveAttribute("data-layout", "horizontal");
  });

  it.each<[string, Widget, string | null]>([
    [
      "stacks a bar with a series to 100%",
      {
        type: "bar",
        metric: "m",
        x: "team",
        y: "n",
        series: "outcome",
        stack: "percent",
      },
      "expand",
    ],
    [
      "stacks a bar with a series by its values when not asked for percent",
      { type: "bar", metric: "m", x: "team", y: "n", series: "outcome" },
      null,
    ],
  ])("%s", (_, widget, offset) => {
    render(<CustomWidget widget={widget} result={BY_TEAM} />);

    if (offset) {
      expect(chartOf("bar-chart")).toHaveAttribute("data-stack-offset", offset);
    } else {
      expect(chartOf("bar-chart")).not.toHaveAttribute("data-stack-offset");
    }
    expect(screen.getAllByTestId("bar").map((bar) => bar.dataset.name)).toEqual(
      ["failed", "ok"]
    );
  });

  it.each<[string, Widget, Record<string, string>]>([
    [
      "a line",
      {
        type: "line",
        metric: "m",
        x: "team",
        y: "n",
        target: { value: 2, label: "Goal" },
      },
      { y: "2", label: "Goal" },
    ],
    [
      "an area",
      { type: "area", metric: "m", x: "team", y: "n", target: { value: 2 } },
      { y: "2" },
    ],
    [
      "a bar",
      { type: "bar", metric: "m", x: "team", y: "n", target: { value: 2 } },
      { y: "2" },
    ],
    [
      "a horizontal bar, across its value axis",
      {
        type: "bar",
        metric: "m",
        x: "team",
        y: "n",
        horizontal: true,
        target: { value: 2 },
      },
      { x: "2" },
    ],
    [
      "a bar stacked to 100%, as a share",
      {
        type: "bar",
        metric: "m",
        x: "team",
        y: "n",
        series: "outcome",
        stack: "percent",
        target: { value: 15 },
      },
      { y: "0.15" },
    ],
  ])("draws the target line of %s", (_, widget, expected) => {
    render(<CustomWidget widget={widget} result={BY_TEAM} />);

    const target = screen.getByTestId("target");
    expect({ ...target.dataset, testid: undefined }).toEqual({
      testid: undefined,
      ...expected,
    });
  });

  it("draws no target line on a chart without one", () => {
    render(
      <CustomWidget
        widget={{ type: "line", metric: "m", x: "team", y: "n" }}
        result={BY_TEAM}
      />
    );

    expect(screen.queryByTestId("target")).not.toBeInTheDocument();
  });

  it("draws a line by series as one line per value, with a gap where a series has no value", () => {
    render(
      <CustomWidget
        widget={{
          type: "line",
          metric: "m",
          x: "team",
          y: "n",
          series: "outcome",
        }}
        result={BY_TEAM}
      />
    );

    const lines = screen.getAllByTestId("line");
    expect(lines.map((line) => line.dataset.name)).toEqual(["failed", "ok"]);
    expect(lines.every((line) => line.dataset.stackId === undefined)).toBe(
      true
    );
    const data = JSON.parse(chartOf("line-chart").dataset.chartData!) as Record<
      string,
      unknown
    >[];
    expect(
      data.map((point) => [point.team, point["stack-0"], point["stack-1"]])
    ).toEqual([
      ["Atlas", 1, 3],
      ["Borealis", null, 2],
    ]);
    expect(screen.getByTestId("legend")).toBeInTheDocument();
  });

  it("stacks an area by series, with 0 where a series has no value", () => {
    render(
      <CustomWidget
        widget={{
          type: "area",
          metric: "m",
          x: "team",
          y: "n",
          series: "outcome",
        }}
        result={BY_TEAM}
      />
    );

    const areas = screen.getAllByTestId("area");
    expect(areas.map((area) => area.dataset.name)).toEqual(["failed", "ok"]);
    expect(areas.every((area) => area.dataset.stackId === "stack")).toBe(true);
    const data = JSON.parse(chartOf("area-chart").dataset.chartData!) as Record<
      string,
      unknown
    >[];
    expect(data.map((point) => point["stack-0"])).toEqual([1, 0]);
  });

  it.each<Widget>([
    { type: "line", metric: "m", x: "team", y: "n", series: "region" },
    { type: "area", metric: "m", x: "team", y: "n", series: "region" },
  ])("names a missing series column of a $type", (widget) => {
    render(<CustomWidget widget={widget} result={BY_TEAM} />, { wrapper });

    expect(screen.getByRole("alert")).toHaveTextContent("draws region");
  });
});
