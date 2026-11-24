// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  SectionTrend,
  type SectionTrendPoint,
  type SectionTrendSeries,
} from "./section-trend";

// WORKAROUND: Recharts draws nothing without a real layout, so the primitives report their props as data attributes.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ComposedChart: ({
    data,
    children,
  }: {
    data: unknown[];
    children: React.ReactNode;
  }) => (
    <div data-testid="plot" data-rows={JSON.stringify(data)}>
      {children}
    </div>
  ),
  XAxis: () => <div data-testid="x" />,
  CartesianGrid: () => null,
  ReferenceLine: ({ y }: { y: number }) => (
    <div data-testid="target" data-y={y} />
  ),
}));

vi.mock("@gears-frontx/ui-kit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ChartContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="chart">{children}</div>
  ),
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

vi.mock("@/components/chart-series", () => ({
  ChartLine: ({ dataKey, yAxisId }: { dataKey: string; yAxisId: string }) => (
    <div data-testid="line" data-key={dataKey} data-axis={yAxisId} />
  ),
  ChartArea: ({
    dataKey,
    stackId,
  }: {
    dataKey: string;
    stackId?: string;
  }) => <div data-testid="area" data-key={dataKey} data-stack={stackId ?? ""} />,
  YAxis: ({ yAxisId }: { yAxisId: string }) => (
    <div data-testid={`y-${yAxisId}`} />
  ),
}));

const SERIES: SectionTrendSeries[] = [
  { key: "collab.messages_sent", label: "Messages" },
  { key: "collab.meeting_hours", label: "Meeting hours", yAxisId: "right" },
];

const DATA: SectionTrendPoint[] = [
  { date: "2026-07-01", "collab.messages_sent": 10, "collab.meeting_hours": 2 },
  { date: "2026-07-02", "collab.messages_sent": 20 },
];

function renderTrend(props: Partial<Parameters<typeof SectionTrend>[0]> = {}) {
  return render(
    <SectionTrend title="Collaboration" series={SERIES} data={DATA} {...props} />,
  );
}

describe("SectionTrend", () => {
  it("remaps metric keys to CSS-safe aliases in both series and rows", () => {
    renderTrend();
    const keys = screen
      .getAllByTestId(/line|area/)
      .map((el) => el.getAttribute("data-key"));
    expect(keys.every((k) => k && !k.includes("."))).toBe(true);
    const rows = JSON.parse(
      screen.getByTestId("plot").getAttribute("data-rows")!,
    ) as Array<Record<string, unknown>>;
    for (const key of keys) expect(rows[0]).toHaveProperty(key!);
    expect(rows[0]).not.toHaveProperty("collab.messages_sent");
  });

  it("drops a null reading instead of rewriting it as zero", () => {
    renderTrend();
    const rows = JSON.parse(
      screen.getByTestId("plot").getAttribute("data-rows")!,
    ) as Array<Record<string, unknown>>;
    expect(Object.keys(rows[1]!)).toHaveLength(2);
  });

  it("renders the right axis when a series asks for it, without the prop", () => {
    renderTrend();
    expect(screen.getByTestId("y-right")).toBeInTheDocument();
  });

  it("omits the right axis when no series uses it", () => {
    renderTrend({ series: [SERIES[0]!] });
    expect(screen.queryByTestId("y-right")).not.toBeInTheDocument();
  });

  it("keeps the right axis when a caller pins it", () => {
    renderTrend({ series: [SERIES[0]!], rightAxis: true });
    expect(screen.getByTestId("y-right")).toBeInTheDocument();
  });

  it("stacks only a stacked-area series", () => {
    renderTrend({
      series: [
        { key: "a.b", label: "A", type: "stacked-area" },
        { key: "c.d", label: "C", type: "area" },
      ],
      data: [{ date: "2026-07-01", "a.b": 1, "c.d": 2 }] as SectionTrendPoint[],
    });
    const stacks = screen
      .getAllByTestId("area")
      .map((el) => el.getAttribute("data-stack"));
    expect(stacks).toEqual(["stack", ""]);
  });

  it("shows a skeleton while pending, and no chart", () => {
    renderTrend({ isPending: true });
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  });

  it("offers a retry on failure instead of an empty chart", () => {
    const onRetry = vi.fn();
    renderTrend({ isError: true, onRetry });
    expect(screen.getByText(/unable to load/)).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  });

  it("says there is no data yet rather than drawing an empty plot", () => {
    renderTrend({ data: [] });
    expect(screen.getByText("No trend data yet.")).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  });

  it("draws the target line at the given value", () => {
    renderTrend({ targetLine: { value: 8, label: "target" } });
    expect(screen.getByTestId("target")).toHaveAttribute("data-y", "8");
  });
});
