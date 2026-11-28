import { useTranslation } from "react-i18next";

import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import { compareOverTime, formatDelta } from "@/lib/portal/metrics-compare";
import {
  formatPeriodRange,
  teamSum,
  type TeamTimePeriods,
} from "@/lib/portal/metrics-team-time";
import {
  computationWord,
  directionNote,
  formatViewValue,
} from "@/lib/portal/metrics-view";
import { cn } from "@/lib/utils";

const HEAD_CELL = "sticky top-0 z-10 border-b bg-muted px-3 py-2 text-start font-medium";
const BODY_CELL = "border-b px-3 py-2 text-start whitespace-nowrap tabular-nums";
const NO_VALUE = "—";

export function MetricsTeamTimeTable({
  keys,
  after,
  before,
  memberIds,
  periods,
}: {
  keys: readonly string[];
  after: ReadonlyMap<string, NormalizedMetricResult>;
  before: ReadonlyMap<string, NormalizedMetricResult>;
  memberIds: readonly string[];
  periods: TeamTimePeriods;
}) {
  const { t } = useTranslation();

  return (
    <div className="max-h-[75svh] overflow-auto rounded-lg border bg-card">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{t("metrics_view.team_time_caption")}</caption>
        <thead>
          <tr>
            <th scope="col" className={cn(HEAD_CELL, "min-w-44")}>
              {t("metrics_view.metric")}
            </th>
            <th scope="col" className={HEAD_CELL}>
              {t("metrics_view.after", { range: formatPeriodRange(periods.after) })}
            </th>
            <th scope="col" className={HEAD_CELL}>
              {t("metrics_view.before", { range: formatPeriodRange(periods.before) })}
            </th>
          </tr>
        </thead>
        <tbody>
          {keys.flatMap((key) => {
            const afterResult = after.get(key);
            const beforeResult = before.get(key);
            const result = afterResult ?? beforeResult;
            if (!result) return [];

            const afterValue = afterResult ? teamSum(afterResult, memberIds) : null;
            const beforeValue = beforeResult ? teamSum(beforeResult, memberIds) : null;
            const change = compareOverTime(afterValue, beforeValue, result);

            return [
              <tr key={key} className="hover:bg-muted/50">
                <th scope="row" className="border-b px-3 py-2 text-start font-normal">
                  {result.label}
                  <MetricNote result={result} />
                </th>
                <td className={BODY_CELL}>
                  <TeamValue value={afterValue} result={result} />
                  {change ? (
                    <>
                      {" "}
                      <span
                        className={cn(
                          "ms-1 text-xs",
                          change.better === true
                            ? "text-success"
                            : change.better === false
                              ? "text-destructive"
                              : "text-muted-foreground",
                        )}
                      >
                        {formatDelta(change.delta, result)}
                      </span>
                    </>
                  ) : null}
                </td>
                <td className={BODY_CELL}>
                  <TeamValue value={beforeValue} result={result} />
                </td>
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function MetricNote({ result }: { result: NormalizedMetricResult }) {
  if (result.direction === "neutral") {
    return (
      <span className="text-xs text-muted-foreground">{` · ${computationWord(result)}`}</span>
    );
  }
  return <span>{` · ${directionNote(result)}`}</span>;
}

function TeamValue({ value, result }: { value: number | null; result: NormalizedMetricResult }) {
  if (value == null) return <span className="text-muted-foreground">{NO_VALUE}</span>;
  return <>{formatViewValue(value, result)}</>;
}
