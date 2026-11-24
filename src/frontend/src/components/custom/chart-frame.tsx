import type { ReactElement } from "react";
import { CartesianGrid, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@gears-frontx/ui-kit";

import {
  categoryTick,
  compactNumber,
  groupedNumber,
  shortDate,
  spansYears,
} from "@/components/custom/chart-format";
import { cn } from "@/lib/utils";

export function ChartFrame({
  config,
  testId,
  fillHeight = false,
  children,
}: {
  config: ChartConfig;
  testId: string;
  fillHeight?: boolean;
  children: ReactElement;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("w-full", fillHeight ? "h-full" : "h-64")}
    >
      <ChartContainer config={config} className="h-full w-full">
        {children}
      </ChartContainer>
    </div>
  );
}

export function SeriesAxes({
  x,
  categories,
  unit = "",
}: {
  x: string;
  categories: unknown[];
  unit?: string;
}) {
  const withYear = spansYears(categories);

  return (
    <>
      <CartesianGrid vertical={false} strokeDasharray="4 4" />
      <XAxis
        dataKey={x}
        tickLine={false}
        axisLine={false}
        tickMargin={8}
        minTickGap={24}
        interval="preserveStartEnd"
        tickFormatter={(value) => categoryTick(value, withYear)}
      />
      <YAxis
        tickLine={false}
        axisLine={false}
        width={44}
        tickCount={5}
        tickFormatter={(value) => compactNumber(value, unit)}
      />
      <ChartTooltip
        cursor={false}
        content={
          <ChartTooltipContent
            indicator="dot"
            labelFormatter={(label) => shortDate(label, true)}
            formatter={(value, name) =>
              `${name}  ${groupedNumber(value, unit)}`
            }
          />
        }
      />
    </>
  );
}

export { ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent };
