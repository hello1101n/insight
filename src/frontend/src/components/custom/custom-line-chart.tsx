import { LineChart } from "recharts";

import { ChartLine } from "@/components/chart-series";
import type { MetricResult } from "@/api/custom-client";
import {
  pointClick,
  points,
  seriesConfig,
} from "@/components/custom/chart-data";
import { unitFor } from "@/components/custom/chart-format";
import { ChartFrame, SeriesAxes } from "@/components/custom/chart-frame";

export interface CustomLineChartProps {
  result: MetricResult;
  x: string;
  y: string;
  fillHeight?: boolean;
  onPointClick?: () => void;
}

export function CustomLineChart({
  result,
  x,
  y,
  fillHeight,
  onPointClick,
}: CustomLineChartProps) {
  const data = points(result, [x, y]);

  return (
    <ChartFrame
      config={seriesConfig(y)}
      testId="custom-line-chart"
      fillHeight={fillHeight}
    >
      <LineChart
        data={data}
        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
        onClick={pointClick(onPointClick)}
        className={onPointClick ? "cursor-pointer" : undefined}
      >
        <SeriesAxes
          x={x}
          categories={data.map((point) => point[x])}
          unit={unitFor(result.percents, y)}
        />
        <ChartLine dataKey={y} stroke={`var(--color-${y})`} strokeWidth={2} />
      </LineChart>
    </ChartFrame>
  );
}
