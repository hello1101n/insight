import { afterEach, describe, expect, it } from "vitest";

import i18n from "@/i18n";
import translation from "@/locales/en/translation.json";
import type { MetricDefinition } from "@/api/metric-definitions-client";
import { finiteValue, type NormalizedMetricResult } from "@/lib/metrics/collection";
import { keysWithData } from "@/lib/portal/metrics-view";

import {
  combinedColumn,
  combinedFigure,
  combinedFigureBy,
  LINES_KEY,
  requestedMetricKeys,
  withCombinedColumns,
  withCombinedResults,
} from "./metrics-view-combined";

function definition(key: string): MetricDefinition {
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
  } as MetricDefinition;
}

function result(key: string, values: Array<[string, number | null]>): NormalizedMetricResult {
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
  } as NormalizedMetricResult;
}

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

  it("writes one figure from a total of each part, such as a team sum", () => {
    const byKey = new Map([
      [
        "git.default_branch_lines_added",
        result("git.default_branch_lines_added", [["a", 1500], ["b", 900]]),
      ],
      [
        "git.default_branch_lines_removed",
        result("git.default_branch_lines_removed", [["a", null], ["b", null]]),
      ],
    ]);
    const lines = combinedColumn(LINES_KEY)!;
    const sum = (part: NormalizedMetricResult) => {
      const values = ["a", "b"].flatMap((id) => finiteValue(part, id) ?? []);
      return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
    };

    expect(combinedFigureBy(lines, byKey, sum)).toBe("+2.4 / —");
    expect(combinedFigureBy(lines, byKey, () => null)).toBeNull();
  });
});

describe("combined Lines texts", () => {
  const lines = structuredClone(translation.metrics_view.lines);

  afterEach(() => {
    i18n.addResourceBundle("en", "translation", { metrics_view: { lines } }, true, true);
  });

  it("takes the label, description and unit from the translations", () => {
    i18n.addResourceBundle(
      "en",
      "translation",
      { metrics_view: { lines: { label: "Zeilen", description: "Zeilen im Hauptzweig", unit: "KZ" } } },
      true,
      true,
    );
    const catalog = withCombinedColumns([
      definition("git.default_branch_lines_added"),
      definition("git.default_branch_lines_removed"),
    ]);
    const results = withCombinedResults(
      new Map([
        ["git.default_branch_lines_added", result("git.default_branch_lines_added", [["a", 1500]])],
        ["git.default_branch_lines_removed", result("git.default_branch_lines_removed", [["a", 200]])],
      ]),
    );

    expect(combinedColumn(LINES_KEY)).toMatchObject({
      label: "Zeilen",
      description: "Zeilen im Hauptzweig",
      unit: "KZ",
    });
    expect(catalog.find((m) => m.metric_key === LINES_KEY)).toMatchObject({
      label: "Zeilen",
      description: "Zeilen im Hauptzweig",
      unit: "KZ",
    });
    expect(results.get(LINES_KEY)).toMatchObject({ label: "Zeilen", unit: "KZ" });
  });

  it("ships the English Lines texts", () => {
    expect(lines).toEqual({
      label: "Lines",
      description: "Lines added and removed that reached the default branch",
      unit: "KLOC",
    });
  });
});

describe("combined column visibility", () => {
  it("keeps Lines when the people in view have only one of its parts", () => {
    const byKey = withCombinedResults(
      new Map([
        ["git.default_branch_lines_added", result("git.default_branch_lines_added", [["a", 1500]])],
        ["git.default_branch_lines_removed", result("git.default_branch_lines_removed", [["a", null]])],
      ]),
    );

    expect(keysWithData([LINES_KEY], byKey, ["a"])).toEqual([LINES_KEY]);
  });
});
