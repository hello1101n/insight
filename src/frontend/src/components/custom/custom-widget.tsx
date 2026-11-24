import { isBusy, type MetricResult, type Widget } from "@/api/custom-client";
import { Alert, AlertDescription } from "@gears-frontx/ui-kit";
import { MetricName } from "@/components/custom/metric-name";
import { refusal } from "@/components/custom/refusal";
import { CustomAreaChart } from "@/components/custom/custom-area-chart";
import { CustomBarChart } from "@/components/custom/custom-bar-chart";
import { CustomLineChart } from "@/components/custom/custom-line-chart";
import { CustomPieChart } from "@/components/custom/custom-pie-chart";
import { CustomStat } from "@/components/custom/custom-stat";
import { CustomTable } from "@/components/custom/custom-table";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { useIsAdmin } from "@/queries/identity-me";

export interface CustomWidgetProps {
  widget: Widget;
  result?: MetricResult;
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

  switch (widget.type) {
    case "table":
      return (
        drawable(widget.metric, widget.columns, result) ?? (
          <CustomTable result={result} />
        )
      );
    case "line":
      return (
        drawable(widget.metric, [widget.x, widget.y], result) ?? (
          <CustomLineChart
            result={result}
            x={widget.x}
            y={widget.y}
            fillHeight={fillHeight}
            onPointClick={onPointClick}
          />
        )
      );
    case "bar":
      return (
        drawable(
          widget.metric,
          [widget.x, widget.y, ...(widget.series ? [widget.series] : [])],
          result
        ) ?? (
          <CustomBarChart
            result={result}
            x={widget.x}
            y={widget.y}
            series={widget.series}
            labels={widget.labels}
            fillHeight={fillHeight}
            onPointClick={onPointClick}
          />
        )
      );
    case "area":
      return (
        drawable(widget.metric, [widget.x, widget.y], result) ?? (
          <CustomAreaChart
            result={result}
            x={widget.x}
            y={widget.y}
            fillHeight={fillHeight}
            onPointClick={onPointClick}
          />
        )
      );
    case "stat":
      return (
        drawable(widget.metric, [widget.value], result) ?? (
          <CustomStat
            result={result}
            value={widget.value}
            label={widget.label}
          />
        )
      );
    case "pie":
      return (
        drawable(widget.metric, [widget.label, widget.value], result) ?? (
          <CustomPieChart
            result={result}
            label={widget.label}
            value={widget.value}
            fillHeight={fillHeight}
            onPointClick={onPointClick}
          />
        )
      );
    default:
      return <p>Unknown widget type.</p>;
  }
}

function drawable(
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
