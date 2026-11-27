import type { ComponentProps } from "react";
import {
  Area,
  Bar,
  type DotItemDotProps,
  Line,
  YAxis as RechartsYAxis,
} from "recharts";

import { formatAxisTick } from "@/lib/format";

export const BAR_MAX_PX = 24;

const LONE_DOT_RADIUS_PX = 3;

const ACTIVE_DOT = {
  r: 4,
  stroke: "var(--background)",
  strokeWidth: 2,
};

function abbreviatedTick(value: unknown): string {
  return typeof value === "number" ? formatAxisTick(value) : String(value);
}

export function YAxis({
  tickFormatter = abbreviatedTick,
  ...props
}: ComponentProps<typeof RechartsYAxis>) {
  return <RechartsYAxis tickFormatter={tickFormatter} {...props} />;
}

export function ChartBar({
  isAnimationActive = false,
  maxBarSize = BAR_MAX_PX,
  radius = [3, 3, 0, 0],
  ...props
}: ComponentProps<typeof Bar>) {
  return (
    <Bar
      isAnimationActive={isAnimationActive}
      maxBarSize={maxBarSize}
      radius={radius}
      {...props}
    />
  );
}

function plotted(value: unknown): unknown {
  return Array.isArray(value) ? value[1] : value;
}

function LoneDot({ cx, cy, index, points, stroke, value }: DotItemDotProps) {
  if (plotted(value) == null || cx == null || cy == null) return null;

  const lone =
    plotted(points[index - 1]?.value) == null &&
    plotted(points[index + 1]?.value) == null;
  if (!lone) return null;

  return <circle cx={cx} cy={cy} r={LONE_DOT_RADIUS_PX} fill={stroke} />;
}

export function ChartLine({
  isAnimationActive = false,
  type = "monotone",
  dot = LoneDot,
  activeDot = ACTIVE_DOT,
  ...props
}: ComponentProps<typeof Line>) {
  return (
    <Line
      isAnimationActive={isAnimationActive}
      type={type}
      dot={dot}
      activeDot={activeDot}
      {...props}
    />
  );
}

export function ChartArea({
  isAnimationActive = false,
  type = "monotone",
  dot = LoneDot,
  activeDot = ACTIVE_DOT,
  ...props
}: ComponentProps<typeof Area>) {
  return (
    <Area
      isAnimationActive={isAnimationActive}
      type={type}
      dot={dot}
      activeDot={activeDot}
      {...props}
    />
  );
}
