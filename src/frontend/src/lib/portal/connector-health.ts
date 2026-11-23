import { Cron } from "croner";

import type {
  AppliedSchedule,
  ConnectorHealth,
  ConnectorHealthSummary,
  ConnectorInstance,
  ConnectorInstanceRef,
  SyncFact,
  SyncStatus,
} from "@/api/connector-health-client";
import i18n from "@/i18n";
import { nextScheduledRun } from "@/lib/portal/connector-schedule";

export function describeSchedule(schedule: AppliedSchedule): string {
  const timezone = schedule.timezone ?? i18n.t("connectors.controller_time");
  return schedule.suspended
    ? i18n.t("connectors.schedule_suspended", { timezone })
    : timezone;
}

export interface NextRunView {
  text: string;
  detail: string | null;
}

export function describeNextRun(
  schedule: AppliedSchedule,
  now: Date
): NextRunView {
  if (schedule.suspended) {
    return {
      text: i18n.t("connectors.suspended"),
      detail: i18n.t("connectors.suspended_detail"),
    };
  }
  if (schedule.timezone == null) {
    return {
      text: i18n.t("connectors.unknown"),
      detail: i18n.t("connectors.unknown_timezone"),
    };
  }

  const unreadable = {
    text: i18n.t("connectors.unknown"),
    detail: i18n.t("connectors.unknown_expression"),
  };
  try {
    let earliest = Infinity;
    for (const expression of schedule.crons) {
      const next = nextScheduledRun(expression, schedule.timezone, now);
      if (next == null) {
        const cron = new Cron(expression.replaceAll("?", "*"), {
          timezone: schedule.timezone,
          mode: "5-part",
        });
        if (
          cron.getPattern() == null ||
          /[LW#]/i.test(expression.replace(/\b(?:JUL|WED)\b/gi, ""))
        )
          return unreadable;
        continue;
      }
      earliest = Math.min(earliest, next.getTime());
    }

    const delay = earliest - now.getTime();
    if (!Number.isFinite(delay) && schedule.crons.length > 0) {
      return {
        text: i18n.t("connectors.unknown"),
        detail: i18n.t("connectors.no_next_run"),
      };
    }
    if (!Number.isFinite(delay)) return unreadable;

    return { text: describeNextRunDelay(delay), detail: null };
  } catch {
    return unreadable;
  }
}

function describeNextRunDelay(delay: number): string {
  if (delay < MINUTE_MS) return i18n.t("connectors.in_under_minute");

  const minutes = Math.round(delay / MINUTE_MS);
  if (minutes < 60) return i18n.t("connectors.in_minutes", { count: minutes });

  const hours = Math.round(delay / HOUR_MS);
  if (hours < 24) return i18n.t("connectors.in_hours", { count: hours });

  return i18n.t("connectors.in_days", { count: Math.round(delay / DAY_MS) });
}

export type ConnectorTone = "failing" | "unknown" | "active" | "ok" | "idle";

export type ConnectorStateName =
  | "no_longer_configured"
  | "never_synced"
  | "queued"
  | "syncing"
  | "sync_failed"
  | "sync_incomplete"
  | "sync_cancelled"
  | "state_unknown"
  | "sync_ok";

export interface ConnectorStateView {
  state: ConnectorStateName;
  label: string;
  tone: ConnectorTone;
}

const STATE: Record<SyncStatus, ConnectorStateView> = {
  pending: { state: "queued", label: "queued", tone: "active" },
  running: { state: "syncing", label: "syncing", tone: "active" },
  failed: { state: "sync_failed", label: "sync failed", tone: "failing" },
  incomplete: {
    state: "sync_incomplete",
    label: "sync incomplete",
    tone: "failing",
  },
  cancelled: {
    state: "sync_cancelled",
    label: "sync cancelled",
    tone: "idle",
  },
  succeeded: { state: "sync_ok", label: "sync ok", tone: "ok" },
  unknown: { state: "state_unknown", label: "state unknown", tone: "unknown" },
};

const NO_LONGER_CONFIGURED: ConnectorStateView = {
  state: "no_longer_configured",
  label: "no longer configured",
  tone: "idle",
};

const NEVER_SYNCED: ConnectorStateView = {
  state: "never_synced",
  label: "never synced",
  tone: "idle",
};

function parseSyncStatus(word: string): SyncStatus {
  return Object.hasOwn(STATE, word) ? (word as SyncStatus) : "unknown";
}

function stateOf(status: string): ConnectorStateView {
  const view = STATE[parseSyncStatus(status)];
  return { ...view, label: i18n.t(`connectors.${view.state}`) };
}

export function describeConnector(row: ConnectorHealth): ConnectorStateView {
  if (!row.configured) {
    return {
      ...NO_LONGER_CONFIGURED,
      label: i18n.t("connectors.no_longer_configured"),
    };
  }
  if (row.last_sync == null) {
    return { ...NEVER_SYNCED, label: i18n.t("connectors.never_synced") };
  }
  return stateOf(row.last_sync.status);
}

export function describeSync(sync: SyncFact): ConnectorStateView {
  return stateOf(sync.status);
}

export const STALE_AFTER_INTERVALS = 3;

const MIN_INTERVAL_MS = 5 * 60_000;
const MAX_INTERVAL_MS = 60 * 60_000;

export interface RecordingView {
  state: "never_read" | "stopped" | "unmeasured" | "current" | "unreadable";
  label: string;
  detail: string;
}

export function describeRecording(
  summary: Pick<
    ConnectorHealthSummary,
    "as_of" | "checked_at" | "typical_read_interval_ms" | "history_available"
  >
): RecordingView {
  if (!summary.history_available || summary.checked_at == null) {
    return {
      state: "never_read",
      label: i18n.t("connectors.never_read"),
      detail: i18n.t("connectors.never_read_detail"),
    };
  }

  const age = elapsedMs(summary.as_of, summary.checked_at);
  if (age === null) {
    return {
      state: "unreadable",
      label: i18n.t("connectors.unreadable"),
      detail: i18n.t("connectors.unreadable_detail"),
    };
  }

  const threshold = staleAfter(summary.typical_read_interval_ms);

  if (threshold === null) {
    return {
      state: "unmeasured",
      label: i18n.t("connectors.last_checked", { age: describeAge(age) }),
      detail: i18n.t("connectors.last_checked_unmeasured"),
    };
  }

  if (age > threshold) {
    return {
      state: "stopped",
      label: i18n.t("connectors.last_checked_stopped", {
        age: describeAge(age),
      }),
      detail: i18n.t("connectors.stopped_detail"),
    };
  }

  return {
    state: "current",
    label: i18n.t("connectors.last_checked", { age: describeAge(age) }),
    detail: "",
  };
}

function staleAfter(interval: number | null | undefined): number | null {
  if (interval == null || !Number.isFinite(interval) || interval <= 0) {
    return null;
  }
  const clamped = Math.min(
    Math.max(interval, MIN_INTERVAL_MS),
    MAX_INTERVAL_MS
  );
  return clamped * STALE_AFTER_INTERVALS;
}

export function elapsedMs(
  asOf: string,
  since: string | null | undefined
): number | null {
  const now = parseStamp(asOf);
  const then = parseStamp(since);
  if (now === null || then === null) return null;
  const span = now - then;
  return span >= 0 ? span : null;
}

// WORKAROUND: `Date.parse` accepts "2026" and "0" as dates, so only an RFC 3339 shape reaches it.
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export function parseStamp(raw: string | null | undefined): number | null {
  if (typeof raw !== "string" || !RFC3339.test(raw)) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function describeAge(ageInMs: number): string {
  if (ageInMs < MINUTE_MS) return i18n.t("connectors.just_now");
  if (ageInMs < HOUR_MS) {
    return i18n.t("connectors.minutes_ago", {
      count: Math.floor(ageInMs / MINUTE_MS),
    });
  }
  if (ageInMs < DAY_MS) {
    return i18n.t("connectors.hours_ago", {
      count: Math.floor(ageInMs / HOUR_MS),
    });
  }
  return i18n.t("connectors.days_ago", { count: Math.floor(ageInMs / DAY_MS) });
}

export const UNMEASURED = "—";

export function describeInstance(row: ConnectorInstance): string {
  const tenant = row.tenant_id ?? "";
  const source = row.source_id ?? "";
  if (tenant === "" && source === "") return UNMEASURED;
  return `${tenant === "" ? UNMEASURED : tenant} / ${source === "" ? UNMEASURED : source}`;
}

export function instanceKey(row: ConnectorInstanceRef): string {
  return [row.connector, row.tenant_id ?? "", row.source_id ?? ""]
    .map(encodeURIComponent)
    .join("/");
}

export function panelIdFor(row: ConnectorInstanceRef): string {
  const id = instanceKey(row).replaceAll("_", "%5F").replaceAll("/", "_");
  return `connector-syncs-${id}`;
}

export function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return UNMEASURED;
  }
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;

  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${(durationMs / 1_000).toFixed(1)} s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

const IN_FLIGHT: ReadonlySet<ConnectorStateName> = new Set([
  "queued",
  "syncing",
]);

export interface DurationView {
  text: string;
  inFlight: boolean;
}

export function describeDuration(
  sync:
    Pick<SyncFact, "status" | "started_at" | "duration_ms"> | null | undefined,
  asOf: string
): DurationView {
  if (sync == null) return { text: UNMEASURED, inFlight: false };
  if (!IN_FLIGHT.has(stateOf(sync.status).state)) {
    return { text: formatDuration(sync.duration_ms), inFlight: false };
  }

  const running = elapsedMs(asOf, sync.started_at);
  if (running === null) return { text: UNMEASURED, inFlight: false };

  return {
    text: i18n.t("connectors.so_far", { duration: formatDuration(running) }),
    inFlight: true,
  };
}

export function formatRecords(records: number | null | undefined): string {
  if (records == null || !Number.isFinite(records) || records < 0) {
    return UNMEASURED;
  }
  return records.toLocaleString("en-US");
}

export function formatStarted(startedAt: string | null | undefined): string {
  const parsed = parseStamp(startedAt);
  if (parsed === null) return UNMEASURED;
  return `${new Date(parsed).toISOString().replace("T", " ").slice(0, 19)}Z`;
}
