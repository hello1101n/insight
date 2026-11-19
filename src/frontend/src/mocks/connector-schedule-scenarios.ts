import { http, HttpResponse } from "msw";

import { CONNECTORS_BASE } from "@/api/connectors-client";
import type { ConnectorSchedule } from "@/api/connector-health-client";
import { connectorScheduleMocks } from "./connector-schedules";
import { PEOPLE } from "./registry";

export function seedConnectorScheduleScenarios(anchor: Date) {
  const minutesAgo = (minutes: number) =>
    new Date(anchor.getTime() - minutes * 60_000).toISOString();
  const inherited = { crons: ["0 3 * * *"], origin: "descriptor" as const };
  const live = {
    crons: inherited.crons,
    origin: inherited.origin,
    timezone: "UTC",
    suspended: false,
    observed_at: minutesAgo(1),
  };
  const saved = {
    crons: ["0 6 * * *"],
    updated_by: PEOPLE[1].person_id,
    updated_at: minutesAgo(5),
  };
  const pending = {
    revision: 2,
    requested: saved,
    status: "pending",
    pending_reason: "different_schedule",
  } as const;

  const scenarios = [
    {
      connector: "example-messaging",
      sourceId: "default",
      schedule: {
        inherited: { ...inherited, origin: "annotation" },
        live: { ...live, origin: "annotation" },
      },
      write: "applied",
    },
    {
      connector: "example-tracker",
      sourceId: "applied",
      schedule: {
        revision: 3,
        requested: saved,
        status: "applied",
        live: { ...live, crons: saved.crons, origin: "api" },
      },
      failure: 503,
    },
    {
      connector: "example-directory",
      sourceId: "setting-up",
      schedule: {
        status: "pending",
        pending_reason: "awaiting_reconcile",
        inherited: null,
      },
      failure: 412,
    },
    {
      connector: "example-messaging",
      sourceId: "applying",
      schedule: pending,
      write: "unconfirmed",
    },
    {
      connector: "example-messaging",
      sourceId: "overdue",
      schedule: {
        ...pending,
        requested: { ...saved, updated_at: minutesAgo(37) },
      },
      write: "applied",
    },
    {
      connector: "example-warehouse",
      sourceId: "not-scheduled",
      schedule: {
        status: "pending",
        pending_reason: "no_cronworkflow",
        live: null,
        inherited: null,
      },
    },
    {
      connector: "example-inbox",
      sourceId: "paused",
      schedule: { status: "paused", live: { ...live, suspended: true } },
    },
    {
      connector: "example-directory",
      sourceId: "read-error",
      schedule: {
        status: null,
        live: null,
        read_error: "Could not read the sync job in the cluster.",
      },
    },
    {
      connector: "example-directory",
      sourceId: "not-loaded",
      schedule: { live: null },
    },
  ] satisfies Array<{
    connector: string;
    sourceId: string;
    schedule: Partial<ConnectorSchedule>;
    write?: "applied" | "unconfirmed";
    failure?: 412 | 503;
  }>;

  for (const { connector, sourceId, schedule, write, failure } of scenarios) {
    const state = connectorScheduleMocks.read(connector, sourceId);
    Object.assign(state, { live: { ...live }, inherited }, schedule);
    if (write)
      connectorScheduleMocks.setWriteOutcome(connector, sourceId, write);
    if (failure) connectorScheduleMocks.failNext(connector, sourceId, failure);
  }
  return {
    rows: scenarios.map(({ connector, sourceId }) => ({ connector, sourceId })),
    handlers: [
      http.get(
        `${CONNECTORS_BASE}/connectors/example-directory/not-loaded/schedule`,
        () => HttpResponse.json({ status: 503 }, { status: 503 })
      ),
    ],
  };
}
