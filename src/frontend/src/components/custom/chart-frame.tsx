import type { ReactElement } from "react";
import { CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@gears-frontx/ui-kit";

import type { Target } from "@/api/custom-client";
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

const SHARE = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 0,
});

export function SeriesAxes({
  x,
  categories,
  unit = "",
  horizontal = false,
  share = false,
}: {
  x: string;
  categories: unknown[];
  unit?: string;
  horizontal?: boolean;
  share?: boolean;
}) {
  const withYear = spansYears(categories);
  const valueTick = (value: unknown) =>
    share ? SHARE.format(Number(value)) : compactNumber(value, unit);
  const categoryTickOf = (value: unknown) => categoryTick(value, withYear);

  return (
    <>
      <CartesianGrid
        vertical={horizontal}
        horizontal={!horizontal}
        strokeDasharray="4 4"
      />
      {horizontal ? (
        <>
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickCount={5}
            tickFormatter={valueTick}
          />
          <YAxis
            type="category"
            dataKey={x}
            tickLine={false}
            axisLine={false}
            width={120}
            tickFormatter={categoryTickOf}
          />
        </>
      ) : (
        <>
          <XAxis
            dataKey={x}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            interval="preserveStartEnd"
            tickFormatter={categoryTickOf}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={44}
            tickCount={5}
            tickFormatter={valueTick}
          />
        </>
      )}
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

// INVARIANT: a target value is in the units a reader sees, so on a percent stack 15 is the share 0.15.
export function TargetLine({
  target,
  horizontal = false,
  share = false,
}: {
  target: Target | undefined;
  horizontal?: boolean;
  share?: boolean;
}) {
  if (!target) return null;

  const at = share ? target.value / 100 : target.value;
  return (
    <ReferenceLine
      {...(horizontal ? { x: at } : { y: at })}
      ifOverflow="extendDomain"
      stroke="var(--muted-foreground)"
      strokeDasharray="4 4"
      label={
        target.label
          ? {
              value: target.label,
              position: horizontal ? "insideTopLeft" : "insideTopRight",
              fill: "var(--muted-foreground)",
              fontSize: 11,
            }
          : undefined
      }
    />
  );
}

export { ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent };
