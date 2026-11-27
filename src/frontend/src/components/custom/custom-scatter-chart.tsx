import {
  CartesianGrid,
  Scatter,
  ScatterChart,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import type { MetricResult } from "@/api/custom-client";
import {
  type ChartConfig,
  scatterGroups,
  type ScatterPoint,
} from "@/components/custom/chart-data";
import {
  compactNumber,
  groupedNumber,
  unitFor,
} from "@/components/custom/chart-format";
import {
  ChartFrame,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from "@/components/custom/chart-frame";
import { chartColor } from "@/lib/chart-palette";

export interface CustomScatterChartProps {
  result: MetricResult;
  x: string;
  y: string;
  size?: string;
  series?: string;
  label?: string;
  fillHeight?: boolean;
  onPointClick?: () => void;
}

const POINT_AREA_PX: [number, number] = [36, 400];

export function CustomScatterChart({
  result,
  x,
  y,
  size,
  series,
  label,
  fillHeight,
  onPointClick,
}: CustomScatterChartProps) {
  const groups = scatterGroups(result, { x, y, size, series, label });
  const config: ChartConfig = Object.fromEntries(
    groups.map((group, index) => [
      group.key,
      { label: group.label, color: chartColor(index) },
    ])
  );
  const xUnit = unitFor(result, x);
  const yUnit = unitFor(result, y);
  const sizeUnit = size ? unitFor(result, size) : "";

  return (
    <ChartFrame
      config={config}
      testId="custom-scatter-chart"
      fillHeight={fillHeight}
    >
      <ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="4 4" />
        <XAxis
          type="number"
          dataKey="x"
          name={x}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickCount={5}
          tickFormatter={(value) => compactNumber(value, xUnit)}
        />
        <YAxis
          type="number"
          dataKey="y"
          name={y}
          tickLine={false}
          axisLine={false}
          width={44}
          tickCount={5}
          tickFormatter={(value) => compactNumber(value, yUnit)}
        />
        {size ? (
          <ZAxis
            type="number"
            dataKey="size"
            name={size}
            range={POINT_AREA_PX}
          />
        ) : null}
        <ChartTooltip
          cursor={false}
          content={({ active, payload }) => {
            const point = payload?.[0]?.payload as ScatterPoint | undefined;
            if (!active || !point) return null;

            return (
              <div className="grid gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
                {label ? (
                  <span className="font-medium">
                    {String(point.label ?? "—")}
                  </span>
                ) : null}
                <span>
                  {x} {groupedNumber(point.x, xUnit)}
                </span>
                <span>
                  {y} {groupedNumber(point.y, yUnit)}
                </span>
                {size ? (
                  <span>
                    {size} {groupedNumber(point.size, sizeUnit)}
                  </span>
                ) : null}
              </div>
            );
          }}
        />
        {series ? (
          <ChartLegend
            content={<ChartLegendContent className="flex-wrap gap-y-1" />}
          />
        ) : null}
        {groups.map((group) => (
          // INVARIANT: the axes name the coordinates, so dataKey only lets the legend find the group's colour and label.
          <Scatter
            key={group.key}
            dataKey={group.key}
            name={group.label}
            data={group.points}
            fill={`var(--color-${group.key})`}
            isAnimationActive={false}
            onClick={onPointClick}
            className={onPointClick ? "cursor-pointer" : undefined}
          />
        ))}
      </ScatterChart>
    </ChartFrame>
  );
}
