import { describe, expect, it } from "vitest";

import type { MetricDefinition } from "@/api/metric-definitions-client";
import type { MetricResult } from "@/api/metric-results-client";
import type { MetricGroup } from "@/lib/insight/groups";
import {
  partState,
  reachableMetricKeys,
  unreachableParts,
} from "@/lib/insight/coverage";
import { normalizeMetricResults } from "@/lib/metrics/collection";

const ME = "019e27bc-dec0-7626-81a9-c5524662a6a9";
const SOMEONE_ELSE = "019e27bc-dec0-7626-81a9-000000000002";

function def(
  metric_key: string,
  over: Partial<MetricDefinition> = {},
): MetricDefinition {
  return {
    metric_key,
    is_enabled: true,
    origin: "builtin",
    schema_status: "ok",
    schema_error_code: null,
    last_observed_date: "2026-08-01",
    ...over,
  } as unknown as MetricDefinition;
}

function metric(
  key: string,
  values: Array<[entity: string, value: number | null]>,
): MetricResult {
  return {
    metric_key: key,
    label: key,
    unit: null,
    format: "integer",
    computation: "sum",
    direction: "higher_is_better",
    views: [
      {
        view: "period",
        values: values.map(([entity_id, value]) => ({ entity_id, value })),
      },
    ],
  } as unknown as MetricResult;
}

function group(id: string, keys: string[]): MetricGroup {
  return {
    id,
    title: `${id} title`,
    collection: { metrics: keys.map((key) => ({ key, views: [] })) },
    card: { preview: [] },
    drilldown: [],
  } as unknown as MetricGroup;
}

describe("reachableMetricKeys", () => {
  it("counts a metric that has observed something", () => {
    expect(reachableMetricKeys([def("git.commits")])).toEqual(
      new Set(["git.commits"]),
    );
  });

  it("drops a metric that has never observed anything", () => {
    expect(
      reachableMetricKeys([def("ai.accepted", { last_observed_date: null })]),
    ).toEqual(new Set());
  });

  it("drops a disabled or schema-broken metric", () => {
    expect(
      reachableMetricKeys([
        def("wiki.edits", { is_enabled: false }),
        def("task.closed", {
          schema_status: "error",
          schema_error_code: "table_not_found",
        }),
      ]),
    ).toEqual(new Set());
  });

  it("keeps a custom metric that has never stamped a freshness date", () => {
    expect(
      reachableMetricKeys([
        def("custom.thing", { origin: "custom", last_observed_date: null }),
      ]),
    ).toEqual(new Set(["custom.thing"]));
  });

  it("still drops a custom metric that is disabled or schema-broken", () => {
    expect(
      reachableMetricKeys([
        def("custom.off", { origin: "custom", is_enabled: false }),
        def("custom.broken", {
          origin: "custom",
          schema_status: "error",
          schema_error_code: "table_not_found",
        }),
      ]),
    ).toEqual(new Set());
  });

  it("keeps an unchecked schema — unchecked is not broken", () => {
    expect(
      reachableMetricKeys([def("ai.accepted", { schema_status: "unchecked" })]),
    ).toEqual(new Set(["ai.accepted"]));
  });
});

describe("partState", () => {
  const PART = group("collaboration", ["collab.messages", "collab.meetings"]);

  it("reads when any metric of the part has a value", () => {
    const byKey = normalizeMetricResults([metric("collab.messages", [[ME, 12]])]);
    expect(
      partState(PART, byKey, ME, reachableMetricKeys([def("collab.messages")])),
    ).toBe("reads");
  });

  it("says nothing recorded when the source reaches us but this person is absent from it", () => {
    const byKey = normalizeMetricResults([
      metric("collab.messages", [[ME, null]]),
    ]);
    expect(
      partState(PART, byKey, ME, reachableMetricKeys([def("collab.messages")])),
    ).toBe("nothing_recorded");
  });

  it("says no data reaches us when nothing in the part has ever observed anything", () => {
    const byKey = normalizeMetricResults([
      metric("collab.messages", [[ME, null]]),
    ]);
    const reachable = reachableMetricKeys([
      def("collab.messages", { last_observed_date: null }),
      def("collab.meetings", { last_observed_date: null }),
    ]);
    expect(partState(PART, byKey, ME, reachable)).toBe("no_data_reaches_us");
  });

  it("does NOT call a part unreachable because nobody in view uses it", () => {
    const byKey = normalizeMetricResults([
      metric("collab.messages", [
        [ME, null],
        [SOMEONE_ELSE, null],
      ]),
    ]);
    expect(
      partState(PART, byKey, ME, reachableMetricKeys([def("collab.messages")])),
    ).toBe("nothing_recorded");
  });

  it("still reads when only one of several metrics is wired", () => {
    const byKey = normalizeMetricResults([metric("collab.meetings", [[ME, 3]])]);
    const reachable = reachableMetricKeys([
      def("collab.meetings"),
      def("collab.messages", { last_observed_date: null }),
    ]);
    expect(partState(PART, byKey, ME, reachable)).toBe("reads");
  });
});

describe("unreachableParts", () => {
  const GROUPS = [
    group("git_output", ["git.commits", "git.prs"]),
    group("ai_adoption", ["ai.accepted"]),
  ];

  it("names a part no metric of which has ever observed anything", () => {
    const reachable = reachableMetricKeys([def("git.commits")]);
    expect(unreachableParts(GROUPS, reachable)).toEqual([
      { id: "ai_adoption", title: "ai_adoption title" },
    ]);
  });

  it("does not name a part where one metric of several reaches us", () => {
    const reachable = reachableMetricKeys([def("git.prs"), def("ai.accepted")]);
    expect(unreachableParts(GROUPS, reachable)).toEqual([]);
  });

  it("offers no estimate of who connecting one would reveal", () => {
    const [only] = unreachableParts(GROUPS, new Set(["git.commits"]));
    expect(Object.keys(only)).toEqual(["id", "title"]);
  });
});
