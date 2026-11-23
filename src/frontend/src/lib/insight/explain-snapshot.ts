import type { MetricSnapshot } from "@/api/ai-client";
import type {
  SectionTrendPoint,
  SectionTrendSeries,
} from "@/components/portal/section-trend";

export interface TrendSnapshotContext {
  title: string;
  bucket: string;
  since: string;
  until: string;
  people: number;
}

export interface TrendChartInput {
  title: string;
  series: readonly SectionTrendSeries[];
  data: readonly SectionTrendPoint[];
}

export function trendSnapshot(
  charts: TrendChartInput[],
  { title, bucket, since, until, people }: TrendSnapshotContext
): MetricSnapshot {
  const dates = [
    ...new Set(charts.flatMap((c) => c.data.map((row) => String(row.date)))),
  ].sort();

  const series = charts.flatMap((chart) => {
    const rowByDate = new Map(
      chart.data.map((row) => [String(row.date), row])
    );
    return chart.series.map((s) => ({
      label:
        chart.series.length > 1 ? `${chart.title} — ${s.label}` : chart.title,
      points: dates.map((date) => {
        const row = rowByDate.get(date);
        return row ? numberAt(row, s.key) : null;
      }),
    }));
  });

  return {
    metric_key: charts.map((c) => c.title).join(", "),
    label: title,
    value: "",
    period: bucket,
    since,
    until,
    delta: "",
    peer: people > 0 ? `Totals across ${people} people` : "",
    help: "",
    trend: [],
    scope: "organisation",
    bucket_starts: dates,
    series,
  };
}

function numberAt(row: SectionTrendPoint, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}
