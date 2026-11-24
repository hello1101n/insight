import { Cell, Pie, PieChart } from "recharts";

import type { MetricResult } from "@/api/custom-client";
import {
  type ChartConfig,
  points,
} from "@/components/custom/chart-data";
import {
  categoryTick,
  groupedNumber,
  unitFor,
} from "@/components/custom/chart-format";
import {
  ChartFrame,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/custom/chart-frame";
import { chartColor } from "@/lib/chart-palette";

export interface CustomPieChartProps {
  result: MetricResult;
  label: string;
  value: string;
  fillHeight?: boolean;
  onPointClick?: () => void;
}

export function CustomPieChart({
  result,
  label,
  value,
  fillHeight,
  onPointClick,
}: CustomPieChartProps) {
  const data = points(result, [label, value]);
  const unit = unitFor(result.percents, value);
  const config: ChartConfig = Object.fromEntries(
    data.map((slice, index) => [
      String(slice[label]),
      {
        label: categoryTick(slice[label]),
        color: chartColor(index),
      },
    ])
  );

  return (
    <ChartFrame
      config={config}
      testId="custom-pie-chart"
      fillHeight={fillHeight}
    >
      <PieChart>
        <ChartTooltip
          content={
            <ChartTooltipContent
              nameKey={label}
              hideLabel
              formatter={(sliced, name) =>
                `${name}  ${groupedNumber(sliced, unit)}`
              }
            />
          }
        />
        <ChartLegend content={<ChartLegendContent nameKey={label} />} />
        <Pie
          data={data}
          dataKey={value}
          nameKey={label}
          onClick={onPointClick}
          className={onPointClick ? "cursor-pointer" : undefined}
        >
          {data.map((slice, index) => (
            <Cell
              key={String(slice[label])}
              fill={chartColor(index)}
            />
          ))}
        </Pie>
      </PieChart>
    </ChartFrame>
  );
}
