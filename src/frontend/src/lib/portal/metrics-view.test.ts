import { describe, expect, it } from "vitest";

import type { MetricDefinition } from "@/api/metric-definitions-client";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";

import { identityPerson, pid } from "@/test/identity";

import {
  chunkKeys,
  columnFormula,
  directionNote,
  formatViewValue,
  rolesById,
  teamsById,
  keysWithData,
  metricGroups,
  metricsRows,
  metricsViewCatalog,
  sortRows,
  type MetricsRow,
} from "./metrics-view";

function definition(
  key: string,
  over: Partial<MetricDefinition> = {},
): MetricDefinition {
  return {
    metric_key: key,
    entity_type: "person",
    label: key,
    short_label: null,
    description: null,
    explanation: null,
    unit: null,
    format: "integer",
    direction: "higher_is_better",
    dimensions: [],
    is_enabled: true,
    origin: "builtin",
    schema_status: "ok",
    schema_error_code: null,
    first_observed_date: "2026-01-01",
    last_observed_date: "2026-01-31",
    ...over,
  } as MetricDefinition;
}

function result(
  key: string,
  values: Array<[string, number | null]>,
  over: Partial<NormalizedMetricResult> = {},
): NormalizedMetricResult {
  return {
    metric_key: key,
    label: `${key} label`,
    unit: null,
    computation: "sum",
    format: "integer",
    direction: "higher_is_better",
    period: {
      view: "period",
      values: values.map(([entity_id, value]) => ({ entity_id, value })),
    },
    ...over,
  } as NormalizedMetricResult;
}

describe("metricsViewCatalog", () => {
  const all = () => true;

  it.each([
    ["a tenant metric", definition("ci.runs", { entity_type: "tenant" })],
    ["a disabled metric", definition("git.off", { is_enabled: false })],
    ["a metric in schema error", definition("git.broken", { schema_status: "error" })],
    [
      "a built-in metric no source has fed",
      definition("git.unfed", { last_observed_date: null }),
    ],
  ])("leaves out %s", (_case, excluded) => {
    const kept = definition("git.commits");

    const offered = metricsViewCatalog([excluded, kept], all);

    expect(offered.map((m) => m.metric_key), `should drop ${excluded.metric_key}`).toEqual([
      "git.commits",
    ]);
  });

  it("keeps a custom metric that has never been observed", () => {
    const custom = definition("custom.x", { origin: "custom", last_observed_date: null });

    expect(metricsViewCatalog([custom], all).map((m) => m.metric_key)).toEqual(["custom.x"]);
  });

  it("leaves out a metric the instance hides", () => {
    const offered = metricsViewCatalog(
      [definition("git.commits"), definition("ai.cost")],
      (metric) => metric.metric_key !== "ai.cost",
    );

    expect(offered.map((m) => m.metric_key)).toEqual(["git.commits"]);
  });

  it("orders metrics by family, as the report builder does", () => {
    const offered = metricsViewCatalog(
      [definition("ai.sessions"), definition("collab.messages"), definition("git.commits")],
      all,
    );

    expect(offered.map((m) => m.metric_key)).toEqual([
      "git.commits",
      "collab.messages",
      "ai.sessions",
    ]);
  });
});

describe("chunkKeys", () => {
  it("splits keys into runs no longer than the size", () => {
    expect(chunkKeys(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("returns no chunk for no keys", () => {
    expect(chunkKeys([], 50)).toEqual([]);
  });
});

describe("keysWithData", () => {
  it("keeps a metric only when someone in the rows has a finite value", () => {
    const byKey = new Map([
      ["git.commits", result("git.commits", [["p1", 3], ["p2", null]])],
      ["git.prs", result("git.prs", [["p1", null], ["p2", null]])],
      ["ai.cost", result("ai.cost", [["outside", 9]])],
    ]);

    expect(keysWithData(["git.commits", "git.prs", "ai.cost", "missing"], byKey, ["p1", "p2"])).toEqual([
      "git.commits",
    ]);
  });
});

describe("metricsRows", () => {
  const tree = identityPerson("boss", {}, [
    identityPerson("b"),
    identityPerson("a", {}, [identityPerson("c")]),
  ]);
  const shape = (rows: MetricsRow[]) =>
    rows.map((row) => [row.displayName, row.depth, row.hasReports, row.expanded]);

  it("nests reports under their expanded manager, by name", () => {
    const rows = metricsRows(tree, [], new Set([pid("boss"), pid("a")]));

    expect(shape(rows)).toEqual([
      ["boss", 0, true, true],
      ["a", 1, true, true],
      ["c", 2, false, false],
      ["b", 1, false, false],
    ]);
  });

  it("hides the reports of a collapsed manager", () => {
    const rows = metricsRows(tree, [], new Set([pid("boss")]));

    expect(shape(rows)).toEqual([
      ["boss", 0, true, true],
      ["a", 1, true, false],
      ["b", 1, false, false],
    ]);
  });

  it("lists everyone flat and by name when there is no org chart", () => {
    const people = [
      { person_id: pid("z"), display_name: "z", email: "", username: "" },
      { person_id: pid("m"), display_name: "m", email: "", username: "" },
    ];

    expect(shape(metricsRows(null, people, new Set()))).toEqual([
      ["m", 0, false, false],
      ["z", 0, false, false],
    ]);
  });
});

describe("sortRows", () => {
  const row = (name: string): MetricsRow => ({
    entityId: name,
    displayName: name,
    depth: 2,
    hasReports: false,
    expanded: false,
  });
  const byKey = new Map([
    ["git.commits", result("git.commits", [["a", 1], ["b", 3], ["c", null], ["d", 2]])],
  ]);
  const rows = ["a", "b", "c", "d"].map(row);

  it.each([
    ["descending", ["b", "d", "a", "c"]],
    ["ascending", ["a", "d", "b", "c"]],
  ] as const)("orders people by a metric %s, with no value last", (direction, order) => {
    const sorted = sortRows(rows, "git.commits", direction, byKey);

    expect(sorted.map((r) => r.entityId), `should order ${direction}`).toEqual(order);
    expect(sorted.every((r) => r.depth === 0)).toBe(true);
  });
});

describe("metricGroups", () => {
  it("groups neighbouring metrics under their family name", () => {
    expect(metricGroups(["git.commits", "git.prs", "tasks.closed", "ai.cost"])).toEqual([
      { family: "git", name: "Development · Git", keys: ["git.commits", "git.prs"] },
      { family: "tasks", name: "Development · Delivery", keys: ["tasks.closed"] },
      { family: "ai", name: "AI", keys: ["ai.cost"] },
    ]);
  });
});

describe("rolesById", () => {
  it("maps each person in the tree to their job title, skipping blanks", () => {
    const tree = identityPerson("boss", { job_title: "Head of Engineering" }, [
      identityPerson("a", { job_title: " " }),
      identityPerson("b", { job_title: "Software Engineer" }),
    ]);

    expect(rolesById(tree)).toEqual(
      new Map([
        [pid("boss"), "Head of Engineering"],
        [pid("b"), "Software Engineer"],
      ]),
    );
  });
});

describe("teamsById", () => {
  it("puts each person in their manager's team, and the root in none", () => {
    const tree = identityPerson("boss", {}, [
      identityPerson("a", {}, [identityPerson("c")]),
      identityPerson("b"),
    ]);

    expect(teamsById(tree)).toEqual(
      new Map([
        [pid("a"), { id: pid("boss"), name: "boss" }],
        [pid("c"), { id: pid("a"), name: "a" }],
        [pid("b"), { id: pid("boss"), name: "boss" }],
      ]),
    );
  });

  it("knows no team without a tree", () => {
    expect(teamsById(null)).toEqual(new Map());
  });
});

describe("formatViewValue", () => {
  it.each([
    ["hours in the clock form", 2.0333, "decimal", "h", "2 h 02 min"],
    ["a count with its unit", 149, "integer", "lines", "149 lines"],
    ["a percent", 80.4, "percent", null, "80%"],
    ["a bare number", 40, "integer", null, "40"],
  ] as const)("writes %s", (_case, value, format, unit, text) => {
    expect(formatViewValue(value, { format, unit })).toBe(text);
  });
});

describe("directionNote", () => {
  it.each([
    ["a total where more is better", "sum", "higher_is_better", "Higher is better"],
    ["a ratio where less is better", "ratio", "lower_is_better", "Lower is better"],
    ["a neutral count", "distinct_count", "neutral", "Neutral"],
    ["a median", "median", "lower_is_better", "Median · Lower is better"],
    ["a percentile", "percentile", "higher_is_better", "Percentile · Higher is better"],
    ["a standard deviation", "stddev", "neutral", "Std dev · Neutral"],
  ] as const)("writes %s", (_case, computation, direction, text) => {
    expect(directionNote({ computation, direction })).toBe(text);
  });
});

describe("columnFormula", () => {
  it.each([
    ["a sum with a unit", "sum", "integer", "days", "Total · days"],
    ["a percent ratio", "ratio", "percent", null, "Ratio · %"],
    ["a sum of hours", "sum", "decimal", "h", "Total · h min"],
    ["a unitless sum", "sum", "integer", null, "Total · count"],
    ["a median", "median", "decimal", "h", "Median · h min"],
    ["a percentile", "percentile", "decimal", "min", "Percentile · min"],
    ["a standard deviation", "stddev", "decimal", "min", "Std dev · min"],
    ["a unitless ratio", "ratio", "decimal", null, "Ratio"],
    ["a unitless median", "median", "decimal", null, "Median"],
    ["a distinct count", "distinct_count", "integer", null, "Total · count"],
    ["a currency with no unit", "sum", "currency", null, "Total · USD"],
    ["a currency with another unit, as the cells show USD", "sum", "currency", "EUR", "Total · USD"],
    ["a percent that carries hours", "ratio", "percent", "h", "Ratio · %"],
    ["a unit the label also names", "sum", "integer", "emails", "Total · emails"],
  ] as const)("writes %s", (_case, computation, format, unit, text) => {
    expect(columnFormula({ computation, format, unit })).toBe(text);
  });
});
