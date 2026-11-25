import { AreaChart } from "recharts";

import { ChartArea } from "@/components/chart-series";
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

export interface CustomAreaChartProps {
  result: MetricResult;
  x: string;
  y: string;
  series?: string;
  target?: Target;
  fillHeight?: boolean;
  onPointClick?: () => void;
}

export function CustomAreaChart({
  result,
  x,
  y,
  series,
  target,
  fillHeight,
  onPointClick,
}: CustomAreaChartProps) {
  const {
    rows: data,
    series: areas,
    config,
    stacked,
  } = drawnSeries(result, x, y, series);
  const gradient = `fill-${y}`;

  return (
    <ChartFrame
      config={config}
      testId="custom-area-chart"
      fillHeight={fillHeight}
    >
      <AreaChart
        data={data}
        margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
        onClick={pointClick(onPointClick)}
        className={onPointClick ? "cursor-pointer" : undefined}
      >
        {stacked ? null : (
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor={`var(--color-${y})`}
                stopOpacity={0.7}
              />
              <stop
                offset="95%"
                stopColor={`var(--color-${y})`}
                stopOpacity={0.05}
              />
            </linearGradient>
          </defs>
        )}
        <SeriesAxes
          x={x}
          categories={data.map((point) => point[x])}
          unit={unitFor(result, y)}
        />
        {stacked && (
          <ChartLegend
            content={<ChartLegendContent className="flex-wrap gap-y-1" />}
            itemSorter={null}
          />
        )}
        {areas.map(({ key, label }) => (
          <ChartArea
            key={key}
            dataKey={key}
            name={label}
            stroke={`var(--color-${key})`}
            strokeWidth={2}
            stackId={stacked ? "stack" : undefined}
            fill={stacked ? `var(--color-${key})` : `url(#${gradient})`}
            fillOpacity={stacked ? 0.4 : undefined}
          />
        ))}
        <TargetLine target={target} />
      </AreaChart>
    </ChartFrame>
  );
}
