import { LineChart } from "recharts";

import { ChartLine } from "@/components/chart-series";
import type { MetricResult, Target } from "@/api/custom-client";
import { drawnSeries, pointClick } from "@/components/custom/chart-data";
import { unitFor } from "@/components/custom/chart-format";
import {
  ChartFrame,
  ChartLegend,
  ChartLegendContent,
  SeriesAxes,
  TargetLine,
} from "@/components/custom/chart-frame";

export interface CustomLineChartProps {
  result: MetricResult;
  x: string;
  y: string;
  series?: string;
  target?: Target;
  fillHeight?: boolean;
  onPointClick?: () => void;
}

export function CustomLineChart({
  result,
  x,
  y,
  series,
  target,
  fillHeight,
  onPointClick,
}: CustomLineChartProps) {
  const {
    rows: data,
    series: lines,
    config,
    stacked,
  } = drawnSeries(result, x, y, series, true);

  return (
    <ChartFrame
      config={config}
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
        {stacked && (
          <ChartLegend
            content={<ChartLegendContent className="flex-wrap gap-y-1" />}
            itemSorter={null}
          />
        )}
        {lines.map(({ key, label }) => (
          <ChartLine
            key={key}
            dataKey={key}
            name={label}
            stroke={`var(--color-${key})`}
            strokeWidth={2}
          />
        ))}
        <TargetLine target={target} />
      </LineChart>
    </ChartFrame>
  );
}
