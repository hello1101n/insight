import { AnalyticsApiError } from "@/api/analytics-client";
import { fetchWithAuth } from "@/api/fetch-with-auth";
import type {
  MetricDrilldownCapability,
  MetricDirection,
  MetricEntityType,
  MetricFormat,
} from "@/api/metric-results-client";

const BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "/api/analytics/v1";

export type MetricDefinitionSchemaStatus = "ok" | "error" | "unchecked";

export type MetricDefinitionOrigin = "builtin" | "custom";

export interface MetricDefinition {
  metric_key: string;
  entity_type: MetricEntityType;
  label: string;
  short_label: string | null;
  description: string | null;
  explanation: string | null;
  unit: string | null;
  format: MetricFormat;
  direction: MetricDirection;
  dimensions: string[];
  is_enabled: boolean;
  origin: MetricDefinitionOrigin;
  schema_status: MetricDefinitionSchemaStatus;
  schema_error_code: MetricSchemaErrorCode | null;
  first_observed_date: string | null;
  last_observed_date: string | null;
  settled_through?: string | null;
  drilldown?: MetricDrilldownCapability;
}

type MetricSchemaErrorCode =
  | "table_not_found"
  | "column_not_found"
  | "dimension_not_covered"
  | "unknown";

export interface MetricDefinitionListResponse {
  metrics: MetricDefinition[];
}

export async function listMetricDefinitions(): Promise<MetricDefinitionListResponse> {
  const res = await fetchWithAuth(`${BASE}/metric-definitions`, {
    method: "GET",
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => null);
    throw new AnalyticsApiError(res.status, errorBody);
  }
  try {
    return (await res.json()) as MetricDefinitionListResponse;
  } catch {
    throw new AnalyticsApiError(res.status, { error: "invalid_json" });
  }
}
