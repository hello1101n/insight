import { describe, expect, it } from "vitest";
import type { ConnectorRun } from "@/api/connector-health-client";
import {
  describeRun,
  isActiveRun,
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
    ["waiting_admission", "Queued"],
    ["waiting_pod", "Queued"],
    ["waiting_clickhouse", "Queued"],
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
