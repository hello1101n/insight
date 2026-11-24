import { BASE, JSON_HEADERS, readJson } from "@/api/custom-client";
import type { DrilldownPage } from "@/api/custom-types";
import { fetchWithAuth } from "@/api/fetch-with-auth";

export type PersonalFormat = "number" | "percent" | "duration" | "currency";
export type PersonalDirection =
  "higher_is_better" | "lower_is_better" | "neutral";
export type PersonalCalculation =
  "sum" | "count" | "avg" | "min" | "max" | "ratio" | "percent";

export interface PersonalSharedBy {
  person_id: string;
  name: string | null;
  at: string;
}

export interface PersonalMetric {
  id: string;
  label: string;
  unit: string | null;
  format: PersonalFormat;
  direction: PersonalDirection;
  description: string | null;
  calculation: PersonalCalculation;
  shared_by: PersonalSharedBy | null;
}

export interface PersonalValuesRequest {
  metrics: string[];
  person_ids: string[];
  teams?: Array<{ id: string; person_ids: string[] }>;
  from: string;
  to: string;
}

export interface PersonalValues {
  values: Array<{ metric: string; person_id: string; value: number | null }>;
  teams: Array<{ metric: string; team: string; value: number | null }>;
}

export interface PersonalRecordsRequest {
  person_id: string;
  from: string;
  to: string;
  cursor?: string;
}

export type PersonalRecordsPage = Omit<DrilldownPage, "selection">;

export async function fetchPersonalMetrics(): Promise<PersonalMetric[]> {
  const res = await fetchWithAuth(`${BASE}/personal-metrics`);
  return (await readJson<{ metrics: PersonalMetric[] }>(res)).metrics;
}

export async function fetchPersonalValues(
  request: PersonalValuesRequest
): Promise<PersonalValues> {
  const res = await fetchWithAuth(`${BASE}/personal-metrics/values`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
  return readJson<PersonalValues>(res);
}

export async function fetchPersonalRecords(
  id: string,
  request: PersonalRecordsRequest
): Promise<PersonalRecordsPage> {
  const res = await fetchWithAuth(
    `${BASE}/personal-metrics/${encodeURIComponent(id)}/records`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
    }
  );
  return readJson<PersonalRecordsPage>(res);
}
