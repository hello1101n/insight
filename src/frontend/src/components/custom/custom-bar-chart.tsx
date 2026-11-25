import { BarChart, LabelList } from "recharts";

import { ChartBar } from "@/components/chart-series";
import type { MetricResult, Target } from "@/api/custom-client";
import { drawnSeries, pointClick } from "@/components/custom/chart-data";
import { compactNumber, unitFor } from "@/components/custom/chart-format";
import {
  ChartFrame,
  ChartLegend,
  ChartLegendContent,
  SeriesAxes,
  TargetLine,
} from "@/components/custom/chart-frame";

export interface CustomBarChartProps {
  result: MetricResult;
  x: string;
  y: string;
  series?: string;
  labels?: boolean;
  horizontal?: boolean;
  stack?: "percent";
  target?: Target;
  fillHeight?: boolean;
  onPointClick?: () => void;
}

export function CustomBarChart({
  result,
  x,
  y,
  series,
  labels = false,
  horizontal = false,
  stack,
  target,
  fillHeight,
  onPointClick,
}: CustomBarChartProps) {
  const unit = unitFor(result, y);
  const {
    rows: data,
    series: segments,
    config,
    stacked,
  } = drawnSeries(result, x, y, series);
  const share = stacked !== null && stack === "percent";

  return (
    <ChartFrame
      config={config}
      testId="custom-bar-chart"
      fillHeight={fillHeight}
    >
      <BarChart
        data={data}
        layout={horizontal ? "vertical" : "horizontal"}
        stackOffset={share ? "expand" : undefined}
        margin={{
          top: labels && !horizontal ? 20 : 8,
          right: labels && horizontal ? 40 : 12,
          left: 0,
          bottom: 0,
        }}
        onClick={pointClick(onPointClick)}
        className={onPointClick ? "cursor-pointer" : undefined}
      >
        <SeriesAxes
          x={x}
          categories={data.map((point) => point[x])}
          unit={unit}
          horizontal={horizontal}
          share={share}
        />
        {stacked && (
          <ChartLegend
            content={<ChartLegendContent className="flex-wrap gap-y-1" />}
            itemSorter={null}
          />
        )}
        {segments.map(({ key, label }) => (
          <ChartBar
            key={key}
            dataKey={key}
            name={label}
            fill={`var(--color-${key})`}
            stackId={stacked ? "stack" : undefined}
            radius={stacked ? 0 : horizontal ? [0, 3, 3, 0] : undefined}
          >
            {labels && (
              <LabelList
                {...(stacked
                  ? {
                      valueAccessor: (entry: {
                        payload: Record<string, unknown>;
                      }) =>
                        entry.payload[stacked.top] === key
                          ? (entry.payload[stacked.total] as number)
                          : undefined,
                    }
                  : { dataKey: y })}
                position={horizontal ? "right" : "top"}
                className="fill-foreground"
                fontSize={11}
                // WORKAROUND: a Recharts label wraps at a space to the bar's width, so a two-part duration keeps a no-break space.
                formatter={(value) =>
                  compactNumber(value, unit).replace(" ", " ")
                }
              />
            )}
          </ChartBar>
        ))}
        <TargetLine target={target} horizontal={horizontal} share={share} />
      </BarChart>
    </ChartFrame>
  );
}
