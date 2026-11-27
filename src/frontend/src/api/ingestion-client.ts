import { CONNECTORS_BASE, ConnectorsApiError } from "@/api/connectors-client";
import { fetchWithAuth } from "@/api/fetch-with-auth";
import { lookbackFrom } from "@/lib/ingestion-chart";

export type IngestionGrain = "15m" | "1s";

export type IngestionSeries = "connector" | "stream" | "total";

export interface IngestionPoint {
  bucket: string;
  key: string;
  rows: number;
}

export interface IngestionIntensity {
  grain: IngestionGrain;
  series: IngestionSeries;
  from: string;
  to: string;
  scope?: string;
  truncated: boolean;
  points: IngestionPoint[];
}

export interface IngestionIntensityRequest {
  grain: IngestionGrain;
  series?: IngestionSeries;
  scope?: string | null;
  from?: string;
  to?: string;
  lookbackDays?: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithAuth(url);
  if (!res.ok) {
    throw new ConnectorsApiError(res.status, await res.json().catch(() => null));
  }
  return (await res.json()) as T;
}

export function intensityParams(
  req: IngestionIntensityRequest,
  now: number,
): URLSearchParams {
  const params = new URLSearchParams({ grain: req.grain });
  if (req.series) params.set("series", req.series);
  if (req.scope) params.set("scope", req.scope);
  const from =
    req.from ??
    (req.lookbackDays === undefined
      ? undefined
      : lookbackFrom(now, req.lookbackDays));
  if (from) params.set("from", from);
  if (req.to) params.set("to", req.to);
  return params;
}

export async function getIngestionIntensity(
  req: IngestionIntensityRequest,
): Promise<IngestionIntensity> {
  return getJson<IngestionIntensity>(
    `${CONNECTORS_BASE}/ingestion/intensity?${intensityParams(req, Date.now())}`,
  );
}
