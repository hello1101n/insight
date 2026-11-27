import type { MetricDirection } from "@/api/metric-results-client";
import type { Better, MetricResult } from "@/api/custom-client";
import {
  groupedNumber,
  toNumber,
  unitFor,
} from "@/components/custom/chart-format";
import { ChangeBadge } from "@/components/widgets/dashboard/change-badge";
import { computeDelta, shownDelta, type ShownDelta } from "@/lib/metrics/delta";
import { TEXT_FIGURE, TEXT_LABEL } from "@/lib/type-scale";

export interface CustomStatProps {
  result: MetricResult;
  value: string;
  label?: string;
  compare?: { better?: Better };
  previous?: MetricResult;
}

const DIRECTION: Record<Better, MetricDirection> = {
  higher: "higher_is_better",
  lower: "lower_is_better",
  neutral: "neutral",
};

function figure(result: MetricResult | undefined, value: string): unknown {
  return result?.rows[0]?.[result.columns.indexOf(value)];
}

function change(
  now: unknown,
  before: unknown,
  percent: boolean,
  better: Better
): ShownDelta | null {
  const delta = computeDelta(
    toNumber(now),
    toNumber(before),
    percent ? "ratio" : "sum",
    percent ? "percent" : "decimal"
  );

  return delta && shownDelta(delta, DIRECTION[better]);
}

export function CustomStat({
  result,
  value,
  label,
  compare,
  previous,
}: CustomStatProps) {
  const unit = unitFor(result, value);
  const shown = figure(result, value);
  const delta = compare
    ? change(
        shown,
        figure(previous, value),
        unit === "%",
        compare.better ?? "higher"
      )
    : null;

  return (
    <div data-testid="custom-stat" className="flex flex-col gap-1">
      <span className={TEXT_FIGURE}>{groupedNumber(shown, unit)}</span>
      {label ? <span className={TEXT_LABEL}>{label}</span> : null}
      {delta ? (
        <span className="text-xs">
          <ChangeBadge delta={delta} since="since the previous period" />
        </span>
      ) : null}
    </div>
  );
}
