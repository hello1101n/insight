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
    [
      "failed",
      "clickhouse_query_error:47:UNKNOWN_IDENTIFIER",
      "A calculation refers to an unknown field",
    ],
    ["failed", "pod_oom", "The sync exceeded its memory limit"],
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
      ["sync_slot", null, "Waiting for a free sync slot"],
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
      "45.0 s so far"
    );
    expect(
      runDuration({ ...run, status: "failed", duration_ms: 12_000 }, now)
    ).toBe("12.0 s");
    expect(runDuration({ ...run, status: "succeeded" }, now)).toBe("—");
    expect(runDuration({ ...run, status: "unknown" }, now)).toBe("—");
    expect(runDuration({ ...run, started_at: "garbage" }, now)).toBe("—");
    expect(isActiveRun({ ...run, finished_at: now })).toBe(false);
    expect(isActiveRun({ ...run, status: "unknown" })).toBe(true);
  });
});
