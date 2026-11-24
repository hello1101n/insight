import { BarChart, CartesianGrid, Cell, ReferenceLine, XAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  Card,
  CardAction,
  CardContent,
  CardHeader,
} from "@gears-frontx/ui-kit";

import { ChartBar, YAxis } from "@/components/chart-series";
import { evidenceSelection } from "@/api/metric-drilldown-client";
import { ChartEmpty } from "@/components/widgets/metric-views/chart-empty";
import { MetricCardActions } from "@/components/widgets/metric-views/metric-card-actions";
import { formatMetricNumber, formatMetricValue } from "@/lib/format";
import { forEntity, type NormalizedMetricResult } from "@/lib/metrics/collection";
import { STATUS_COLOR_VAR, statusVsMedian, type Status } from "@/lib/status";

export interface MetricHistogramProps {
  metric: NormalizedMetricResult;
  entityId: string;
}

const COUNT_KEY = "count";
const CONFIG: ChartConfig = { [COUNT_KEY]: { label: "Count" } };

const MIN_FILL_OPACITY = 0.35;
const MAX_FILL_OPACITY = 0.95;

type BinRow = {
  label: string;
  count: number;
  status: Status;
  opacity: number;
  straddlesPivot: boolean;
};

function directionText(metric: NormalizedMetricResult): string | null {
  if (metric.direction === "higher_is_better") return "Higher is better";
  if (metric.direction === "lower_is_better") return "Lower is better";
  return null;
}

function buildRows(
  bins: Array<{ lo: number; hi: number; count: number }>,
  pivot: number | null,
  metric: NormalizedMetricResult,
): { rows: BinRow[]; pivotLabel: string | null } {
  const diverging = pivot != null && metric.direction !== "neutral";
  const higherIsBetter = metric.direction === "higher_is_better";
  const mids = bins.map((bin) => (bin.lo + bin.hi) / 2);
  const maxDistance = diverging
    ? Math.max(...mids.map((mid) => Math.abs(mid - pivot)), Number.EPSILON)
    : 1;

  let pivotLabel: string | null = null;
  const rows = bins.map((bin, index) => {
    const label = `${formatMetricNumber(bin.lo, metric.format)}–${formatMetricNumber(bin.hi, metric.format)}`;
    const isLastBin = index === bins.length - 1;
    const straddlesPivot =
      diverging &&
      bin.lo <= pivot &&
      (pivot < bin.hi || (isLastBin && pivot <= bin.hi));
    if (straddlesPivot) pivotLabel = label;
    const status: Status =
      !diverging || straddlesPivot
        ? "neutral"
        : statusVsMedian(mids[index]!, pivot, higherIsBetter);
    const intensity = diverging
      ? Math.abs(mids[index]! - pivot) / maxDistance
      : 0.6;
    return {
      label,
      count: bin.count,
      status,
      opacity: MIN_FILL_OPACITY + intensity * (MAX_FILL_OPACITY - MIN_FILL_OPACITY),
      straddlesPivot,
    };
  });
  return { rows, pivotLabel };
}

export function MetricHistogram({ metric, entityId }: MetricHistogramProps) {
  const data = forEntity(metric, entityId);
  const bins = data.histogram[0]?.bins ?? [];
  const ownMedian = data.value;
  const peerMedian = data.peer?.median ?? null;
  const direction = directionText(metric);
  const evidence = metric.drilldown
    ? evidenceSelection(metric.selection, entityId)
    : null;

  const header = (
    <CardHeader>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold" title={metric.label}>
            {metric.label}
          </span>
          <span className="text-xs text-muted-foreground">
            {[
              direction,
              peerMedian != null
                ? `vs peer median ${formatMetricValue(peerMedian, metric.format, metric.unit)}`
                : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        {ownMedian != null ? (
          <span className="shrink-0 text-xs leading-8 text-muted-foreground">
            Median{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {formatMetricValue(ownMedian, metric.format, metric.unit)}
            </span>
          </span>
        ) : null}
      </div>
      {evidence ? (
        <CardAction className="-mr-2">
          <MetricCardActions
            evidence={evidence}
            label={metric.label}
            placement="inline"
          />
        </CardAction>
      ) : null}
    </CardHeader>
  );

  if (bins.length === 0) {
    return (
      <Card className="shrink-0">
        {header}
        <CardContent>
          <ChartEmpty message="No values in this period" />
        </CardContent>
      </Card>
    );
  }

  const { rows, pivotLabel } = buildRows(bins, peerMedian, metric);

  return (
    <Card className="shrink-0">
      {header}
      <CardContent>
        <ChartContainer config={CONFIG} className="h-48 min-h-48 w-full">
          <BarChart
            data={rows}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke="var(--border)"
            />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              allowDecimals={false}
              width={28}
              tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
              tickLine={false}
              axisLine={false}
            />
            <ChartTooltip content={<ChartTooltipContent className="min-w-40" />} />
            <ChartBar dataKey={COUNT_KEY} name="Count">
              {rows.map((row) => (
                <Cell
                  key={row.label}
                  fill={STATUS_COLOR_VAR[row.status]}
                  fillOpacity={row.opacity}
                />
              ))}
            </ChartBar>
            {pivotLabel ? (
              <ReferenceLine
                x={pivotLabel}
                stroke="var(--foreground)"
                strokeDasharray="4 3"
              />
            ) : null}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
