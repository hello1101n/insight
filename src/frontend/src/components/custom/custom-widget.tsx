import { isBusy, type MetricResult, type Widget } from "@/api/custom-client";
import { Alert, AlertDescription } from "@gears-frontx/ui-kit";
import { MetricName } from "@/components/custom/metric-name";
import { refusal } from "@/components/custom/refusal";
import { CustomAreaChart } from "@/components/custom/custom-area-chart";
import { CustomBarChart } from "@/components/custom/custom-bar-chart";
import { CustomLineChart } from "@/components/custom/custom-line-chart";
import {
  FUNNEL_STAGE,
  FUNNEL_VALUE,
  funnelStages,
  largestFirst,
  projected,
} from "@/components/custom/chart-data";
import { CustomPieChart } from "@/components/custom/custom-pie-chart";
import { CustomScatterChart } from "@/components/custom/custom-scatter-chart";
import { CustomStat } from "@/components/custom/custom-stat";
import { CustomTable } from "@/components/custom/custom-table";
import { drawnColumns } from "@/lib/custom/draws-bucket";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { useIsAdmin } from "@/queries/identity-me";

// INVARIANT: a scatter of more points than this draws as a table, which caps the rows it shows.
const SCATTER_POINTS = 500;

export interface CustomWidgetProps {
  widget: Widget;
  result?: MetricResult;
  previous?: MetricResult;
  error?: unknown;
  windowed?: boolean;
  pending?: boolean;
  onRetry?: () => void;
  fillHeight?: boolean;
  onPointClick?: () => void;
}

export function CustomWidget({
  widget,
  result,
  previous,
  error,
  windowed,
  pending,
  onRetry,
  fillHeight = false,
  onPointClick,
}: CustomWidgetProps) {
  const { isAdmin, isPending } = useIsAdmin();
  const member = !isPending && !isAdmin;
  const busy = isBusy(error);

  if (busy && !pending) {
    return (
      <ComingSoon
        variant="card"
        state="error"
        label="Busy, try again."
        onRetry={onRetry}
      />
    );
  }

  if (error && !busy) {
    if (member) {
      return (
        <ComingSoon
          variant="card"
          state="error"
          label="This widget couldn't be loaded."
          onRetry={onRetry}
        />
      );
    }
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {refusal(error, "The metric could not be run.")}
        </AlertDescription>
      </Alert>
    );
  }

  if (pending || !result) {
    return <CenteredSpinner className="min-h-40" />;
  }

  if (result.rows.length === 0) {
    return (
      <ComingSoon
        variant="card"
        state="empty"
        label={
          windowed ? "Nothing in this window. Try a wider range." : "No data."
        }
      />
    );
  }

  const missing = missingColumnsNotice(
    widget.metric,
    drawnColumns(widget),
    result
  );
  if (missing) return missing;

  switch (widget.type) {
    case "table":
      return <CustomTable result={result} />;
    case "line":
      return (
        <CustomLineChart
          result={result}
          x={widget.x}
          y={widget.y}
          series={widget.series}
          target={widget.target}
          fillHeight={fillHeight}
          onPointClick={onPointClick}
        />
      );
    case "bar":
      return (
        <CustomBarChart
          result={result}
          x={widget.x}
          y={widget.y}
          series={widget.series}
          labels={widget.labels}
          horizontal={widget.horizontal}
          stack={widget.stack}
          target={widget.target}
          colors={widget.colors}
          fillHeight={fillHeight}
          onPointClick={onPointClick}
        />
      );
    case "area":
      return (
        <CustomAreaChart
          result={result}
          x={widget.x}
          y={widget.y}
          series={widget.series}
          target={widget.target}
          fillHeight={fillHeight}
          onPointClick={onPointClick}
        />
      );
    case "stat":
      return (
        <CustomStat
          result={result}
          value={widget.value}
          label={widget.label}
          compare={widget.compare}
          previous={previous}
        />
      );
    case "pie":
      return (
        <CustomPieChart
          result={result}
          label={widget.label}
          value={widget.value}
          fillHeight={fillHeight}
          onPointClick={onPointClick}
        />
      );
    case "heatmap":
      return <CustomTable result={projected(result, drawnColumns(widget))} />;
    case "funnel":
      return (
        <CustomBarChart
          result={funnelStages(result, widget.stages)}
          x={FUNNEL_STAGE}
          y={FUNNEL_VALUE}
          horizontal
          labels
          fillHeight={fillHeight}
          onPointClick={onPointClick}
        />
      );
    case "treemap":
      return (
        <CustomBarChart
          result={largestFirst(result, widget.label, widget.value)}
          x={widget.label}
          y={widget.value}
          horizontal
          fillHeight={fillHeight}
          onPointClick={onPointClick}
        />
      );
    case "scatter":
      return result.rows.length > SCATTER_POINTS ? (
        <CustomTable result={projected(result, drawnColumns(widget))} />
      ) : (
        <CustomScatterChart
          result={result}
          x={widget.x}
          y={widget.y}
          size={widget.size}
          series={widget.series}
          label={widget.label}
          fillHeight={fillHeight}
          onPointClick={onPointClick}
        />
      );
    default:
      return <p>Unknown widget type.</p>;
  }
}

function missingColumnsNotice(
  metric: string,
  drawn: string[],
  result: MetricResult
): React.ReactElement | null {
  const missing = drawn.filter((column) => !result.columns.includes(column));
  if (missing.length === 0) return null;

  return (
    <MissingColumns
      metric={metric}
      missing={missing}
      returned={result.columns}
    />
  );
}

function MissingColumns({
  metric,
  missing,
  returned,
}: {
  metric: string;
  missing: string[];
  returned: string[];
}) {
  const { isAdmin, isPending } = useIsAdmin();
  const member = !isPending && !isAdmin;

  return (
    <Alert variant="destructive">
      <AlertDescription>
        {!member ? (
          <>
            This widget draws {missing.join(", ")}, which{" "}
            <MetricName id={metric} /> does not return. Its columns are{" "}
            {returned.join(", ")}.
          </>
        ) : (
          "Couldn't draw this widget."
        )}
      </AlertDescription>
    </Alert>
  );
}
