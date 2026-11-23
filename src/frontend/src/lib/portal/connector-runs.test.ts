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
      "ClickHouse could not resolve a name in the SQL query (UNKNOWN_IDENTIFIER, code 47).",
    ],
    ["failed", "pod_oom", "Pod memory limit exceeded"],
    ["failed", "stage_failed", "No detailed failure reason was recorded."],
    ["wait_timeout", null, "Wait exceeded six hours"],
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
    ["starting", "Starting"],
    ["waiting_admission", "Waiting for stage admission from connectors"],
    ["waiting_pod", "Waiting for Kubernetes pod placement"],
    ["waiting_clickhouse", "Waiting for ClickHouse"],
    ["loading", "Loading"],
    ["transforming", "Transforming"],
    ["checking_start", "Checking sync start"],
    ["wait_warning", "Warning · waiting over 3 hours"],
    ["wait_timeout", "Failed · waited over 6 hours"],
    ["running", "Running"],
    ["succeeded", "Ready"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
    ["unknown", "Unknown"],
    ["constructor", "Unknown"],
  ])("labels %s as %s", (status, label) =>
    expect(describeRun(status).label).toBe(label)
  );

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
