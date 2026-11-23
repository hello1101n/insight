import { useTranslation } from "react-i18next";
import { CartesianGrid, ComposedChart, ReferenceLine, XAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  Skeleton,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@gears-frontx/ui-kit";

import { ChartArea, ChartLine, YAxis } from "@/components/chart-series";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { chartColor } from "@/lib/chart-palette";

export type SectionTrendSeries = {
  key: string;
  label: string;
  type?: "line" | "step" | "area" | "stacked-area";
  yAxisId?: "left" | "right";
};

export type SectionTrendPoint = {
  date: string;
  [seriesKey: string]: number | string;
};

export interface SectionTrendProps {
  title: string;
  description?: string;
  series: SectionTrendSeries[];
  data: SectionTrendPoint[];
  targetLine?: { value: number; label: string };
  rightAxis?: boolean;
  height?: number;
  isPending?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  onBucketClick?: (bucket: string) => void;
}

export function SectionTrend({
  title,
  description,
  series,
  data,
  targetLine,
  rightAxis,
  height = 180,
  isPending,
  isError,
  onRetry,
  onBucketClick,
}: SectionTrendProps) {
  const { t } = useTranslation();
  if (isPending) {
    return <Skeleton className="h-48 w-full" />;
  }
  if (isError) {
    return (
      <ComingSoon
        state="error"
        label={t("common.chart.unable_to_load_named", { title })}
        onRetry={onRetry}
      />
    );
  }
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{t("common.chart.no_trend")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // WORKAROUND: a dot in a key breaks the `--color-<key>` custom property and reads as a
  // nested path to Recharts, so series and rows are rekeyed to safe aliases.
  const safeKeys = series.map((s, i) => `s${i}_${s.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
  const safeSeries = series.map((s, i) => ({ ...s, key: safeKeys[i] }));
  const safeData = data.map((row) => {
    const next: SectionTrendPoint = { date: row.date as string };
    series.forEach((s, i) => {
      const v = row[s.key];
      if (v != null) next[safeKeys[i]] = v;
    });
    return next;
  });

  // WORKAROUND: Recharts silently drops a `yAxisId: "right"` series when no right YAxis renders.
  const needsRightAxis =
    rightAxis || safeSeries.some((s) => s.yAxisId === "right");

  const config: ChartConfig = Object.fromEntries(
    safeSeries.map((s, i) => [
      s.key,
      { label: s.label, color: chartColor(i) },
    ]),
  );

  return (
    <Card className="relative">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? (
          <CardDescription>{description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={config}
          className="w-full"
          style={{ height }}
        >
          <ComposedChart
            data={safeData}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            className={onBucketClick ? "cursor-pointer" : undefined}
            onClick={
              onBucketClick
                ? (next, event) => {
                    const bucket = next?.activeLabel;
                    if (typeof bucket !== "string") return;
                    (
                      event as { stopPropagation?: () => void }
                    )?.stopPropagation?.();
                    onBucketClick(bucket);
                  }
                : undefined
            }
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="left"
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
            />
            {needsRightAxis ? (
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={28}
              />
            ) : null}
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            {targetLine ? (
              <ReferenceLine
                yAxisId="left"
                y={targetLine.value}
                stroke="var(--success)"
                strokeDasharray="4 4"
                label={{
                  value: targetLine.label,
                  position: "right",
                  fontSize: 10,
                  fill: "var(--success)",
                }}
              />
            ) : null}
            {safeSeries.map((s) => {
              const yAxisId = s.yAxisId ?? "left";
              const color = `var(--color-${s.key})`;
              if (s.type === "area" || s.type === "stacked-area") {
                return (
                  <ChartArea
                    key={s.key}
                    yAxisId={yAxisId}
                    dataKey={s.key}
                    name={s.label}
                    stackId={s.type === "stacked-area" ? "stack" : undefined}
                    stroke={color}
                    fill={color}
                    fillOpacity={0.25}
                    strokeWidth={2}
                  />
                );
              }
              return (
                <ChartLine
                  key={s.key}
                  yAxisId={yAxisId}
                  dataKey={s.key}
                  name={s.label}
                  type={s.type === "step" ? "stepAfter" : undefined}
                  stroke={color}
                  strokeWidth={2}
                />
              );
            })}
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
