import { describe, expect, it } from "vitest";
import type { ConnectorRun } from "@/api/connector-health-client";
import { describeRunState } from "./connector-run-view";
import {
  describeRun,
  isActiveRun,
  projectRun,
  runDuration,
  stageFailureReason,
} from "./connector-runs";

const run: ConnectorRun = {
  sync_id: "jira",
  status: "loading",
  started_at: "2026-11-20T01:00:00Z",
  stages: [],
};
const now = "2026-11-20T01:03:00Z";

describe("connector run state", () => {
  it.each([
    ["airbyte_launch_rejected", "Airbyte refused the sync request"],
    ["airbyte_launch_unconfirmed", "Airbyte did not confirm the sync launch"],
    [
      "airbyte_launch_unreadable",
      "The Airbyte job list was unavailable. The sync launch is not confirmed.",
    ],
    ["airbyte_job_failed", "The Airbyte job failed"],
    ["airbyte_job_cancelled", "Airbyte cancelled the job"],
    ["clickhouse_memory_limit", "ClickHouse memory limit exceeded"],
    [
      "clickhouse_user_memory_limit",
      "Syncs reached their shared ClickHouse memory limit",
    ],
    [
      "clickhouse_server_memory_pressure",
      "ClickHouse ran out of available server memory",
    ],
    ["pod_oom", "The sync exceeded its memory limit"],
    ["source_pod_oom", "The source exceeded its memory limit"],
    ["workflow_not_found", "The sync record could not be found"],
    ["wait_timeout", "Waited over 6 hours"],
    [
      "clickhouse_query_error:47:UNKNOWN_IDENTIFIER",
      "A calculation refers to an unknown field",
    ],
    [
      "clickhouse_query_error:62:SYNTAX_ERROR",
      "A calculation could not be completed",
    ],
  ])("gives %s its specific failure text", (reason, expected) => {
    expect(
      stageFailureReason({
        stage: "bronze",
        attempt: 1,
        status: "failed",
        reason,
      })
    ).toBe(expected);
  });

  it.each([
    ["failed", "stage_failed", "The step failed"],
    ["wait_timeout", null, "Waited over 6 hours"],
  ] as const)("explains %s with %s", (status, reason, expected) => {
    expect(
      stageFailureReason({
        stage: "transform-legacy",
        attempt: 1,
        status,
        reason,
      })
    ).toBe(expected);
  });
  it.each([
    ["queued", "Queued"],
    ["starting", "Queued"],
    ["loading", "Bronze"],
    ["transforming", "Running"],
    ["checking_start", "Queued"],
    ["wait_warning", "Queued"],
    ["wait_timeout", "Failed"],
    ["running", "Running"],
    ["succeeded", "Ready"],
    ["failed", "Failed"],
    ["not_started", "Failed"],
    ["cancelled", "Cancelled"],
    ["unknown", "Unknown"],
    ["constructor", "Unknown"],
  ])("labels %s as %s", (status, label) =>
    expect(describeRun(status).label).toBe(label)
  );

  it("keeps one queued label and explains the current Argo or placement wait", () => {
    const queued_at = "2026-11-20T01:00:00Z";
    const reasons = [
      ["lock", "another-sync", "Waiting for a lock held by another-sync"],
      ["lock", null, "Waiting for a lock"],
      ["sync_slot", null, "Waiting for a free load slot"],
      ["placement", null, "Waiting for cluster capacity"],
    ] as const;
    for (const [kind, holder, reason] of reasons) {
      const view = describeRunState(
        {
          ...run,
          status: "queued",
          stages: [
            {
              stage: "bronze",
              attempt: 1,
              status: "queued",
              queued_at,
              waits: [{ kind, started_at: queued_at, holder }],
            },
          ],
        },
        now
      );
      expect(view.label).toBe("Queued");
      expect(view.queueReasons).toEqual([reason]);
    }
  });

  it("keeps a retried execution active after the previous Bronze attempt failed", () => {
    const reopened = projectRun({
      ...run,
      status: "starting",
      execution_started_at: now,
      stages: [
        {
          stage: "bronze",
          attempt: 1,
          status: "not_started",
          reason: "airbyte_launch_rejected",
          finished_at: run.started_at,
        },
      ],
    });
    expect(reopened.stages).toHaveLength(1);
    expect(
      projectRun({
        ...reopened,
        stages: [
          {
            stage: "transform-legacy",
            attempt: 1,
            status: "succeeded",
            finished_at: run.started_at,
          },
        ],
      }).status
    ).toBe("starting");
    expect(isActiveRun(reopened)).toBe(true);
    expect(reopened.status).toBe("starting");
  });

  it("treats not_started as terminal without a finish timestamp", () => {
    expect(isActiveRun({ ...run, status: "not_started" })).toBe(false);
  });

  it("uses the observation clock for an open run and the measured duration for a closed one", () => {
    expect(runDuration(run, now)).toBe("3m 0s so far");
    expect(runDuration({ ...run, duration_ms: 45_000 }, now)).toBe(
      "45s so far"
    );
    expect(
      runDuration({ ...run, status: "failed", duration_ms: 12_000 }, now)
    ).toBe("12s");
    expect(runDuration({ ...run, status: "succeeded" }, now)).toBe("—");
    expect(runDuration({ ...run, status: "unknown" }, now)).toBe("—");
    expect(runDuration({ ...run, started_at: "garbage" }, now)).toBe("—");
    expect(isActiveRun({ ...run, finished_at: now })).toBe(false);
    expect(isActiveRun({ ...run, status: "unknown" })).toBe(true);
  });
});
