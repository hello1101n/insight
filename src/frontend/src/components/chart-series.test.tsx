// @vitest-environment jsdom
import { ChartContainer, type ChartConfig } from "@gears-frontx/ui-kit";
import { render } from "@testing-library/react";
import { AreaChart, BarChart, LineChart } from "recharts";
import { describe, expect, it } from "vitest";

import { ChartArea, ChartBar, ChartLine, YAxis } from "./chart-series";

const CONFIG: ChartConfig = { v: { label: "V", color: "#f00" } };

function renderSeries(data: Array<{ d: string; v: number | null }>) {
  return render(
    <ChartContainer config={CONFIG} className="h-40 w-96">
      <LineChart data={data} width={384} height={160}>
        <ChartLine dataKey="v" stroke="#f00" />
      </LineChart>
    </ChartContainer>
  );
}

const series = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ d: `2026-07-${i + 1}`, v: i + 1 }));

describe("ChartLine defaults", () => {
  it("draws no per-point dots on a connected series", () => {
    const { container } = renderSeries(series(7));
    expect(container.querySelectorAll("circle")).toHaveLength(0);
  });

  it("always marks a lone reading between gaps, however long the series", () => {
    const data = Array.from({ length: 60 }, (_, i) => ({
      d: `d${i}`,
      v: i === 15 ? 42 : null,
    }));
    const { container } = renderSeries(data);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });

  it("marks only the lone reading, not readings that have a neighbour", () => {
    const { container } = renderSeries([
      { d: "a", v: 1 },
      { d: "b", v: 2 },
      { d: "c", v: null },
      { d: "d", v: 4 },
      { d: "e", v: null },
    ]);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });

  it("joins readings with a smooth curve", () => {
    const { container } = renderSeries(series(4));
    const path = container.querySelector("path.recharts-line-curve");
    expect(path?.getAttribute("d")).toMatch(/C/);
  });

  it("lets a caller override the curve for step-like counters", () => {
    const { container } = render(
      <ChartContainer config={CONFIG} className="h-40 w-96">
        <LineChart data={series(4)} width={384} height={160}>
          <ChartLine dataKey="v" stroke="#f00" type="stepAfter" />
        </LineChart>
      </ChartContainer>
    );
    const d = container
      .querySelector("path.recharts-line-curve")
      ?.getAttribute("d");
    expect(d).toMatch(/L/);
    expect(d).not.toMatch(/C/);
  });
});

describe("ChartArea defaults", () => {
  it("marks a lone reading, which encloses no area of its own", () => {
    const { container } = render(
      <ChartContainer config={CONFIG} className="h-40 w-96">
        <AreaChart
          data={[
            { d: "a", v: 1 },
            { d: "b", v: 2 },
            { d: "c", v: null },
            { d: "d", v: 4 },
            { d: "e", v: null },
          ]}
          width={384}
          height={160}
        >
          <ChartArea dataKey="v" stroke="#f00" fill="#f00" />
        </AreaChart>
      </ChartContainer>
    );
    expect(container.querySelectorAll("circle")).toHaveLength(1);
  });
});

describe("ChartBar defaults", () => {
  it("caps the bar width when few categories share a wide chart", () => {
    const { container } = render(
      <ChartContainer config={CONFIG} className="h-40 w-96">
        <BarChart data={series(3)} width={384} height={160}>
          <ChartBar dataKey="v" fill="#f00" />
        </BarChart>
      </ChartContainer>
    );
    const widths = [
      ...container.querySelectorAll("path.recharts-rectangle"),
    ].map((bar) => Number(bar.getAttribute("width")));
    expect(widths).toHaveLength(3);
    expect(widths.every((width) => width === 24)).toBe(true);
  });
});

describe("YAxis defaults", () => {
  const renderAxis = (domainMax: number) =>
    render(
      <ChartContainer config={CONFIG} className="h-40 w-96">
        <LineChart
          data={[
            { d: "a", v: 0 },
            { d: "b", v: domainMax },
          ]}
          width={384}
          height={160}
        >
          <YAxis />
          <ChartLine dataKey="v" stroke="#f00" />
        </LineChart>
      </ChartContainer>
    );

  const ticks = (c: HTMLElement) =>
    [...c.querySelectorAll(".recharts-cartesian-axis-tick-value")].map(
      (t) => t.textContent ?? ""
    );

  it("abbreviates large ticks so they fit the axis gutter", () => {
    const { container } = renderAxis(40_000);
    expect(ticks(container).some((t) => t.endsWith("k"))).toBe(true);
    expect(ticks(container).every((t) => !/^\d{5}/.test(t))).toBe(true);
  });

  it("leaves small ticks literal", () => {
    const { container } = renderAxis(300);
    expect(ticks(container).every((t) => !t.includes("k"))).toBe(true);
  });

  it("lets a caller keep raw numbers", () => {
    const { container } = render(
      <ChartContainer config={CONFIG} className="h-40 w-96">
        <LineChart
          data={[
            { d: "a", v: 0 },
            { d: "b", v: 40_000 },
          ]}
          width={384}
          height={160}
        >
          <YAxis tickFormatter={(v: number) => String(v)} />
          <ChartLine dataKey="v" stroke="#f00" />
        </LineChart>
      </ChartContainer>
    );
    expect(ticks(container).some((t) => /^\d{5}$/.test(t))).toBe(true);
  });
});
