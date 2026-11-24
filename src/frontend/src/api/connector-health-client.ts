import i18n from "@/i18n";

import { CONNECTORS_BASE, ConnectorsApiError } from "@/api/connectors-client";
import { fetchWithAuth } from "@/api/fetch-with-auth";

export type SyncStatus =
  | "pending"
  | "running"
  | "incomplete"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface SyncFact {
  job_id: string;
  status: string;
  started_at?: string | null;
  duration_ms?: number | null;
  records_reported?: number | null;
}

export interface ConnectorRunStage {
  waits?: {
    kind: "lock" | "sync_slot" | "check_slot" | "placement";
    holder?: string | null;
    started_at: string;
    ended_at?: string | null;
  }[];
  stage: string;
  attempt: number;
  airbyte_job_id?: string | null;
  status: string;
  queued_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  reason?: string | null;
}

export interface ConnectorRun {
  sync_id: string;
  execution_started_at?: string;
  status: string;
  started_at: string;
  finished_at?: string | null;
  duration_ms?: number | null;
  wait_ms?: number | null;
  load_ms?: number | null;
  transform_ms?: number | null;
  records_reported?: number | null;
  stages: ConnectorRunStage[];
}

export interface ConnectorInstance {
  tenant_id?: string | null;
  source_id?: string | null;
}

export type ScheduleOrigin = "api" | "annotation" | "descriptor" | "default";

export interface InheritedSchedule {
  crons: string[];
  origin: ScheduleOrigin;
}

export interface AppliedSchedule {
  crons: string[];
  suspended: boolean;
  timezone?: string | null;
  origin?: ScheduleOrigin | null;
}

export interface LiveSchedule extends AppliedSchedule {
  observed_at: string;
}

export interface ConnectorHealth extends ConnectorInstance {
  connector: string;
  configured: boolean;
  schedule?: AppliedSchedule | null;
  schedule_request?: ScheduleRequestState | null;
  last_sync?: SyncFact | null;
  latest_run?: ConnectorRun | null;
  last_successful_run?: ConnectorRun | null;
}

export type SchedulePendingReason =
  "no_cronworkflow" | "awaiting_reconcile" | "different_schedule";

export type ScheduleStatus = "inherited" | "pending" | "applied" | "paused";

export interface RequestedSchedule {
  crons: string[];
  updated_at: string;
  updated_by: string;
}

export interface ScheduleRequestState {
  read_error?: string | null;
  crons: string[];
  revision: number;
  last_observation?: {
    status: ScheduleStatus;
    observed_at: string;
  } | null;
}

export interface ConnectorSchedule {
  connector: string;
  source_id: string;
  revision: number;
  requested?: RequestedSchedule | null;
  live?: LiveSchedule | null;
  inherited?: InheritedSchedule | null;
  status: ScheduleStatus | null;
  read_error?: string | null;
  pending_reason?: SchedulePendingReason | null;
  next_reconcile_at?: string | null;
  reconcile_interval_secs?: number | null;
}

export interface ScheduleRead {
  schedule: ConnectorSchedule;
  etag: string;
}

async function scheduleRequest(
  instance: ConnectorInstanceRef,
  method: "GET" | "PUT" | "DELETE",
  etag?: string,
  crons?: string[]
): Promise<ScheduleRead> {
  const headers: Record<string, string> = {};
  if (etag !== undefined) headers["If-Match"] = etag;
  if (method === "PUT") headers["Content-Type"] = "application/json";
  const res = await fetchWithAuth(
    `${CONNECTORS_BASE}/connectors/${encodeURIComponent(instance.connector)}/${encodeURIComponent(instance.source_id ?? "")}/schedule`,
    {
      method,
      headers,
      body: method === "PUT" ? JSON.stringify({ crons }) : undefined,
    }
  );
  if (!res.ok)
    throw new ConnectorsApiError(
      res.status,
      await res.json().catch(() => null)
    );
  const schedule = (await res.json()) as ConnectorSchedule;
  const revision = res.headers.get("ETag");
  if (revision === null)
    throw new Error(i18n.t("connectors.schedule.missing_revision"));
  return { schedule, etag: revision };
}

export const getConnectorSchedule = (instance: ConnectorInstanceRef) =>
  scheduleRequest(instance, "GET");
export const putConnectorSchedule = (
  instance: ConnectorInstanceRef,
  etag: string,
  crons: string[]
) => scheduleRequest(instance, "PUT", etag, crons);
export const deleteConnectorSchedule = (
  instance: ConnectorInstanceRef,
  etag: string
) => scheduleRequest(instance, "DELETE", etag);

export interface ConnectorInstanceRef extends ConnectorInstance {
  connector: string;
}

export interface ConnectorHealthSummary {
  schedule_read_error?: string | null;
  history_read_error?: string | null;
  as_of: string;
  checked_at?: string | null;
  typical_read_interval_ms?: number | null;
  history_available: boolean;
  connectors: ConnectorHealth[];
}

export interface ConnectorSyncHistory extends ConnectorInstance {
  connector: string;
  syncs: SyncFact[];
  runs?: ConnectorRun[];
  history_read_error?: string | null;
  window: number;
}

export async function getConnectorHealth(): Promise<ConnectorHealthSummary> {
  const res = await fetchWithAuth(`${CONNECTORS_BASE}/connector-health`);
  if (!res.ok) {
    throw new ConnectorsApiError(
      res.status,
      await res.json().catch(() => null)
    );
  }
  return (await res.json()) as ConnectorHealthSummary;
}

export async function getConnectorSyncs(
  instance: ConnectorInstanceRef
): Promise<ConnectorSyncHistory> {
  const scope = new URLSearchParams();
  if (instance.tenant_id != null && instance.source_id != null) {
    scope.set("tenant_id", instance.tenant_id);
    scope.set("source_id", instance.source_id);
  }
  const query = scope.toString();
  const res = await fetchWithAuth(
    `${CONNECTORS_BASE}/connector-health/${encodeURIComponent(instance.connector)}/syncs` +
      (query === "" ? "" : `?${query}`)
  );
  if (!res.ok) {
    throw new ConnectorsApiError(
      res.status,
      await res.json().catch(() => null)
    );
  }
  return (await res.json()) as ConnectorSyncHistory;
}
