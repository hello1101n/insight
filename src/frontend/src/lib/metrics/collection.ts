import type { DateRange } from "@/api/period-to-date-range";
import type {
  BreakdownView,
  HistogramView,
  MetricBucket,
  MetricComputation,
  MetricDirection,
  MetricDimensionFilter,
  MetricErrorView,
  MetricFormat,
  MetricGroupLimit,
  MetricResult,
  MetricResultViewKind,
  MetricResultsRequest,
  MetricViewRequest,
  NotReadyReason,
  PeerView,
  PeriodView,
  PersonAbsenceContext,
  RollupView,
  TimeseriesView,
  UnattributedView,
} from "@/api/metric-results-client";

type MetricCollectionBucket = MetricBucket | "auto";

export interface MetricTimeseriesGroupLimitConfig {
  count: number;
  rankBy?: string;
  includeRemainder: boolean;
}

type MetricCollectionViewConfig =
  | { view: "period" }
  | { view: "peer" }
  | {
      view: "timeseries";
      bucket: MetricCollectionBucket;
      dimensions?: string[];
      groupLimit?: MetricGroupLimit;
    }
  | {
      view: "breakdown";
      dimensions: string[];
    }
  | {
      view: "rollup";
      dimensions: string[];
      groupLimit?: MetricGroupLimit;
    }
  | { view: "histogram" }
  | { view: "unattributed" };

interface MetricCollectionMetricConfig {
  key: string;
  filters?: MetricDimensionFilter[];
  views: MetricCollectionViewConfig[];
}

export interface MetricCollectionConfig {
  metrics: MetricCollectionMetricConfig[];
}

export function filterCollectionToAvailable(
  collection: MetricCollectionConfig,
  available: ReadonlySet<string> | null,
): MetricCollectionConfig {
  if (!available) return collection;
  return filterCollectionByKey(collection, (key) => available.has(key));
}

export function filterCollectionByKey(
  collection: MetricCollectionConfig,
  keep: (metricKey: string) => boolean,
): MetricCollectionConfig {
  const kept = collection.metrics.filter((m) => keep(m.key));
  return kept.length === collection.metrics.length ? collection : { metrics: kept };
}

export function filterCollectionToDeclaredDimensions(
  collection: MetricCollectionConfig,
  declared: ReadonlyMap<string, ReadonlySet<string>> | null,
): MetricCollectionConfig {
  if (!declared) return collection;
  const kept = collection.metrics.filter((metric) => {
    const asked = metric.filters ?? [];
    if (!asked.length) return true;
    const supported = declared.get(metric.key);
    return asked.every((filter) => supported?.has(filter.dimension) ?? false);
  });
  return kept.length === collection.metrics.length ? collection : { metrics: kept };
}

export type MetricCollectionEntity =
  | { type: "person"; ids: string[] }
  | { type: "tenant" };

export type NormalizedMetricResult = {
  absenceContext?: ReadonlyMap<string, PersonAbsenceContext>;
  metric_key: string;
  label: string;
  short_label?: string;
  description?: string;
  explanation?: string;
  unit: string | null;
  computation: MetricComputation;
  format: MetricFormat;
  direction: MetricDirection;
  scale?: number;
  period?: PeriodView;
  timeseries?: TimeseriesView;
  peer?: PeerView;
  breakdown?: BreakdownView;
  rollup?: RollupView;
  histogram?: HistogramView;
  unattributed?: UnattributedView;
  error?: Pick<MetricErrorView, "code" | "message">;
  notReady?: NotReadyReason;
  drilldown?: MetricResult["drilldown"];
  selection?: MetricResult["selection"];
};

export type PeerEntityStats = PeerView["values"][number];

export interface EntityMetricData {
  absence?: PersonAbsenceContext;
  value: number | null;
  peer: PeerEntityStats | null;
  bucket: MetricBucket | null;
  series: TimeseriesView["series"];
  breakdown: BreakdownView["values"];
  histogram: HistogramView["values"];
}

function exhaustive(value: never): never {
  throw new Error(
    `Unhandled metric collection variant: ${JSON.stringify(value)}`
  );
}

export function buildMetricCollectionRequest(
  collection: MetricCollectionConfig,
  entity: MetricCollectionEntity,
  period: DateRange,
  compareTo?: DateRange
): MetricResultsRequest {
  return {
    entity:
      entity.type === "person"
        ? { type: "person", ids: entity.ids }
        : { type: "tenant" },
    period,
    ...(compareTo ? { compare_to: { ...compareTo } } : {}),
    metrics: collection.metrics.map((metric) => ({
      metric_key: metric.key,
      ...(metric.filters?.length ? { filters: metric.filters } : {}),
      views: metric.views.map((view) => toRequestView(view, period)),
    })),
  };
}

export function projectViews(
  collection: MetricCollectionConfig,
  kinds: readonly MetricResultViewKind[]
): MetricCollectionConfig {
  return {
    metrics: collection.metrics
      .map((metric) => ({
        key: metric.key,
        filters: metric.filters,
        views: metric.views.filter((view) => kinds.includes(view.view)),
      }))
      .filter((metric) => metric.views.length > 0),
  };
}

export function normalizeMetricResult(
  metric: MetricResult
): NormalizedMetricResult {
  const normalized: NormalizedMetricResult = {
    metric_key: metric.metric_key,
    label: metric.label,
    short_label: metric.short_label,
    description: metric.description,
    explanation: metric.explanation,
    unit: metric.unit,
    computation: metric.computation,
    format: metric.format,
    direction: metric.direction,
    scale: metric.computation === "ratio" ? metric.scale : undefined,
  };
  if (metric.drilldown) normalized.drilldown = metric.drilldown;
  if (metric.selection) normalized.selection = metric.selection;

  for (const view of metric.views) {
    switch (view.view) {
      case "period":
        normalized.period = view;
        break;
      case "timeseries":
        normalized.timeseries = view;
        break;
      case "peer":
        normalized.peer = view;
        break;
      case "breakdown":
        normalized.breakdown = view;
        break;
      case "rollup":
        normalized.rollup = view;
        break;
      case "histogram":
        normalized.histogram = view;
        break;
      case "unattributed":
        normalized.unattributed = view;
        break;
      case "error":
        normalized.error ??= { code: view.code, message: view.message };
        break;
      case "not_ready":
        normalized.notReady ??= view.reason;
        break;
      default:
        if (import.meta.env.DEV) {
          console.warn("Ignoring unknown metric view kind", view);
        }
        break;
    }
  }

  return normalized;
}

export function projectComparison(
  results: Map<string, NormalizedMetricResult>
): Map<string, NormalizedMetricResult> {
  const out = new Map<string, NormalizedMetricResult>();
  for (const [key, result] of results) {
    const projected: NormalizedMetricResult = {
      ...result,
      period: undefined,
      timeseries: undefined,
      peer: undefined,
      breakdown: undefined,
      rollup: undefined,
      histogram: undefined,
      unattributed: undefined,
    };
    if (result.period) {
      projected.period = {
        ...result.period,
        values: result.period.values.map((value) => ({
          entity_id: value.entity_id,
          value: value.compare_to ?? null,
        })),
      };
    }
    if (result.breakdown) {
      projected.breakdown = {
        ...result.breakdown,
        values: result.breakdown.values.flatMap((row) => {
          const window = row.compare_to;
          if (!window?.present) return [];
          return [
            { ...row, value: window.value, present: undefined, compare_to: undefined },
          ];
        }),
      };
    }
    out.set(key, projected);
  }
  return out;
}

export function projectPrimary(
  results: Map<string, NormalizedMetricResult>
): Map<string, NormalizedMetricResult> {
  const out = new Map<string, NormalizedMetricResult>();
  for (const [key, result] of results) {
    if (!result.breakdown?.values.some((row) => row.present !== undefined)) {
      out.set(key, result);
      continue;
    }
    out.set(key, {
      ...result,
      breakdown: {
        ...result.breakdown,
        values: result.breakdown.values.flatMap((row) =>
          row.present === false
            ? []
            : [{ ...row, present: undefined, compare_to: undefined }]
        ),
      },
    });
  }
  return out;
}

export function normalizeMetricResults(
  metrics: MetricResult[] | undefined,
  absenceContext?: readonly PersonAbsenceContext[],
): Map<string, NormalizedMetricResult> {
  const absences = absenceContext?.length
    ? new Map(absenceContext.map((context) => [context.person_id, context]))
    : undefined;
  return new Map(
    (metrics ?? []).map((metric) => {
      const normalized = normalizeMetricResult(metric);
      if (absences) normalized.absenceContext = absences;
      return [normalized.metric_key, normalized];
    })
  );
}

export function forEntity(
  result: NormalizedMetricResult,
  entityId: string
): EntityMetricData {
  return {
    ...(result.absenceContext?.has(entityId)
      ? { absence: result.absenceContext.get(entityId) }
      : {}),
    value:
      result.period?.values.find((v) => v.entity_id === entityId)?.value ??
      null,
    peer: result.peer?.values.find((v) => v.entity_id === entityId) ?? null,
    bucket: result.timeseries?.bucket ?? null,
    series:
      result.timeseries?.series.filter((s) => s.entity_id === entityId) ?? [],
    breakdown:
      result.breakdown?.values.filter((v) => v.entity_id === entityId) ?? [],
    histogram:
      result.histogram?.values.filter((v) => v.entity_id === entityId) ?? [],
  };
}

const BACKEND_MAX_PROJECTED_ROWS = 5000;

export const PROJECTED_ROWS_BUDGET = BACKEND_MAX_PROJECTED_ROWS - 500;

const MAX_PERSON_IDS = 1000;

export function entityChunkSize(
  collection: MetricCollectionConfig
): number | null {
  let rowsPerEntity = 0;
  for (const metric of collection.metrics) {
    for (const view of metric.views) {
      if (
        view.view === "timeseries" ||
        view.view === "breakdown" ||
        view.view === "rollup" ||
        view.view === "histogram" ||
        view.view === "unattributed"
      ) {
        return null;
      }
      rowsPerEntity += 1;
    }
  }
  if (rowsPerEntity === 0) return null;
  return Math.min(
    MAX_PERSON_IDS,
    Math.max(1, Math.floor(PROJECTED_ROWS_BUDGET / rowsPerEntity)),
  );
}

export function chunkEntityIds(ids: string[], size: number): string[][] {
  if (ids.length <= size) return [ids];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

export function mergeNormalizedResults(
  maps: Array<Map<string, NormalizedMetricResult>>
): Map<string, NormalizedMetricResult> {
  const out = new Map<string, NormalizedMetricResult>();
  for (const map of maps) {
    for (const [key, result] of map) {
      const existing = out.get(key);
      if (!existing) {
        out.set(key, {
          ...result,
          period: result.period
            ? { ...result.period, values: [...result.period.values] }
            : undefined,
          peer: result.peer
            ? { ...result.peer, values: [...result.peer.values] }
            : undefined,
        });
        continue;
      }
      if (existing.period && result.period) {
        existing.period.values.push(...result.period.values);
      } else if (result.period) {
        existing.period = {
          ...result.period,
          values: [...result.period.values],
        };
      }
      if (result.absenceContext) {
        existing.absenceContext = new Map([
          ...(existing.absenceContext ?? []),
          ...result.absenceContext,
        ]);
      }
      if (existing.peer && result.peer) {
        existing.peer.values.push(...result.peer.values);
      } else if (result.peer) {
        existing.peer = { ...result.peer, values: [...result.peer.values] };
      }
      existing.error ??= result.error;
      existing.notReady ??= result.notReady;
    }
  }
  return out;
}

export function entityObserved(
  result: NormalizedMetricResult,
  entityId: string
): boolean {
  const data = forEntity(result, entityId);
  if (data.peer) return data.peer.target_value != null;
  return data.value != null && data.value !== 0;
}

function toRequestView(
  view: MetricCollectionViewConfig,
  period: DateRange
): MetricViewRequest {
  switch (view.view) {
    case "period":
      return { view: "period" };
    case "peer":
      return { view: "peer" };
    case "timeseries":
      return {
        view: "timeseries",
        bucket: resolveBucket(view.bucket, period),
        dimensions: view.dimensions,
        group_limit: view.groupLimit,
      };
    case "breakdown":
      return { view: "breakdown", dimensions: view.dimensions };
    case "rollup":
      return {
        view: "rollup",
        dimensions: view.dimensions,
        group_limit: view.groupLimit,
      };
    case "histogram":
      return { view: "histogram" };
    case "unattributed":
      return { view: "unattributed" };
    default:
      exhaustive(view);
  }
}

const MAX_DAY_BUCKET_DAYS = 7;
const MIN_MONTH_BUCKET_DAYS = 365;

export function resolveBucket(
  bucket: MetricCollectionBucket,
  period: DateRange
): MetricBucket {
  if (bucket !== "auto") return bucket;
  const days = daysInRange(period);
  if (days <= MAX_DAY_BUCKET_DAYS) return "day";
  if (days >= MIN_MONTH_BUCKET_DAYS) return "month";
  return "week";
}

export function resolveTimeseriesBucket(period: DateRange): MetricBucket {
  return resolveBucket("auto", period);
}

function daysInRange(period: DateRange): number {
  const from = parseDateUtcMs(period.from);
  const to = parseDateUtcMs(period.to);
  if (from == null || to == null || from > to) return 0;
  return Math.floor((to - from) / 86_400_000) + 1;
}

function parseDateUtcMs(value: string): number | null {
  const parts = value.split("-").map(Number);
  if (parts.length !== 3) return null;
  const [year, month, day] = parts;
  if (!year || !month || !day) return null;
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? timestamp
    : null;
}
