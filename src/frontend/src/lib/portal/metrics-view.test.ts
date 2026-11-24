import { describe, expect, it } from "vitest";

import type { MetricDefinition } from "@/api/metric-definitions-client";
import { GROUPS } from "@/lib/insight/groups";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";

import { identityPerson, pid } from "@/test/identity";

import {
  DEFAULT_METRIC_KEYS,
  chunkKeys,
  compareGaps,
  LINES_KEY,
  combinedColumn,
  combinedFigure,
  defaultMetricKeys,
  finiteValue,
  formatGap,
  headerUnit,
  rolesById,
  keysWithData,
  metricGroups,
  metricsRows,
  metricsViewCatalog,
  orderMetricKeys,
  requestedMetricKeys,
  sortRows,
  withCombinedColumns,
  withCombinedResults,
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

describe("DEFAULT_METRIC_KEYS", () => {
  it("names the built-in default metrics", () => {
    expect([...DEFAULT_METRIC_KEYS]).toEqual([
      "git.default_branch_lines",
      "git.pr_size",
      "git.default_branch_prs_merged",
      "git.default_branch_merge_rate",
      "git.pr_cycle_time_h",
      "git.reviews_performed",
      "git.pr_comments",
      "ai.active_days",
      "tasks.closed",
    ]);
  });

  it("names only metrics a person section offers, Lines through its two parts", () => {
    const offered = new Set(
      GROUPS.flatMap((group) => group.collection.metrics.map((metric) => metric.key)),
    );

    expect(requestedMetricKeys(DEFAULT_METRIC_KEYS).filter((key) => !offered.has(key))).toEqual(
      [],
    );
  });
});

describe("defaultMetricKeys", () => {
  it("keeps the catalog keys that are defaults, in catalog order", () => {
    expect(
      defaultMetricKeys(["git.pr_size", "collab.messages_sent", "tasks.closed", "custom.x"]),
    ).toEqual(["git.pr_size", "tasks.closed"]);
  });

  it("uses the stand's list in place of the built-in one when the deploy sets it", () => {
    expect(
      defaultMetricKeys(["git.pr_size", "collab.messages_sent", "custom.x"], [
        "custom.x",
        "collab.messages_sent",
        "git.gone",
      ]),
    ).toEqual(["collab.messages_sent", "custom.x"]);
  });

  it("uses the built-in list when the stand's list is empty", () => {
    expect(defaultMetricKeys(["git.pr_size", "collab.messages_sent"], [])).toEqual([
      "git.pr_size",
    ]);
  });
});

describe("orderMetricKeys", () => {
  it("puts the default keys first, in the default order, then the rest as they came", () => {
    expect(
      orderMetricKeys(["git.a", "tasks.closed", "git.pr_size", "collab.x"], [
        "git.pr_size",
        "tasks.closed",
      ]),
    ).toEqual(["git.pr_size", "tasks.closed", "git.a", "collab.x"]);
  });
});

describe("combined Lines column", () => {
  it("joins the catalog before lines added when both line metrics are in it", () => {
    const catalog = [
      definition("git.pr_size"),
      definition("git.default_branch_lines_added"),
      definition("git.default_branch_lines_removed"),
    ];

    expect(withCombinedColumns(catalog).map((m) => m.metric_key)).toEqual([
      "git.pr_size",
      LINES_KEY,
      "git.default_branch_lines_added",
      "git.default_branch_lines_removed",
    ]);
  });

  it("stays out of the catalog when a line metric is missing", () => {
    const catalog = [definition("git.default_branch_lines_added")];

    expect(withCombinedColumns(catalog).map((m) => m.metric_key)).toEqual([
      "git.default_branch_lines_added",
    ]);
  });

  it("asks for lines added and removed in place of the Lines column", () => {
    expect(
      requestedMetricKeys([LINES_KEY, "git.pr_size", "git.default_branch_lines_added"]),
    ).toEqual([
      "git.default_branch_lines_added",
      "git.default_branch_lines_removed",
      "git.pr_size",
    ]);
  });

  it("ranks by lines added plus removed, in KLOC, and leaves a person with a missing part unranked", () => {
    const byKey = new Map([
      [
        "git.default_branch_lines_added",
        result("git.default_branch_lines_added", [["a", 1500], ["b", null]]),
      ],
      [
        "git.default_branch_lines_removed",
        result("git.default_branch_lines_removed", [["a", 200], ["b", 300]]),
      ],
    ]);

    const lines = withCombinedResults(byKey).get(LINES_KEY)!;

    expect(finiteValue(lines, "a")).toBe(1.7);
    expect(finiteValue(lines, "b")).toBeNull();
    expect(lines.unit).toBe("KLOC");
  });

  it("writes lines added and removed in KLOC with one decimal", () => {
    const byKey = new Map([
      [
        "git.default_branch_lines_added",
        result("git.default_branch_lines_added", [["a", 90412], ["b", 1500], ["c", null]]),
      ],
      [
        "git.default_branch_lines_removed",
        result("git.default_branch_lines_removed", [["a", 5100], ["b", null], ["c", null]]),
      ],
    ]);
    const lines = combinedColumn(LINES_KEY)!;

    expect(combinedFigure(lines, byKey, "a")).toBe("+90.4 / −5.1");
    expect(combinedFigure(lines, byKey, "b")).toBe("+1.5 / —");
    expect(combinedFigure(lines, byKey, "c")).toBeNull();
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

describe("compareGaps", () => {
  it("marks the biggest value best when higher is better, with everyone else's gap in percent", () => {
    expect(compareGaps([50, 200, null, 100], "higher_is_better")).toEqual([
      { best: false, gap: -75 },
      { best: true, gap: null },
      { best: false, gap: null },
      { best: false, gap: -50 },
    ]);
  });

  it("marks the smallest value best when lower is better, with everyone else's excess in percent", () => {
    expect(compareGaps([83, 698], "lower_is_better")).toEqual([
      { best: true, gap: null },
      { best: false, gap: 741 },
    ]);
  });

  it("marks every person who ties for best", () => {
    expect(compareGaps([5, 5, 8], "lower_is_better").map((cell) => cell.best)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it.each([
    ["a neutral metric", [1, 9], "neutral"],
    ["everyone equal", [5, 5], "higher_is_better"],
    ["a single value", [7, null], "higher_is_better"],
    ["no values", [null, null], "lower_is_better"],
  ] as const)("names no best with %s", (_case, values, direction) => {
    expect(compareGaps(values, direction).some((cell) => cell.best)).toBe(false);
  });

  it("gives no percent when the best value is zero", () => {
    expect(compareGaps([0, 4], "lower_is_better")).toEqual([
      { best: true, gap: null },
      { best: false, gap: null },
    ]);
  });
});

describe("formatGap", () => {
  it.each([
    [null, ""],
    [0, "≈"],
    [63, "+63%"],
    [-47, "−47%"],
  ] as const)("writes a gap of %s as %j", (gap, text) => {
    expect(formatGap(gap)).toBe(text);
  });
});

describe("headerUnit", () => {
  it.each([
    ["a count unit the title does not name", "PR size", "integer", "lines", "lines"],
    ["a count unit the title already names", "Commits per PR", "decimal", "commits", null],
    ["hours, which each cell writes as a duration", "Cycle time", "decimal", "h", null],
    ["a percent, which each cell carries", "Merge rate", "percent", null, null],
    ["no unit", "Commits", "integer", null, null],
  ] as const)("header unit for %s", (_case, label, format, unit, shown) => {
    expect(headerUnit(label, format, unit)).toBe(shown);
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
