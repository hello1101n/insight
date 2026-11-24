import { describe, expect, it, vi } from "vitest";

import {
  buildMetricErrorView,
  buildMetricNotReadyView,
} from "@/mocks/metric-results-factory";
import {
  MEDIAN_METRIC_FIXTURE,
  RATIO_METRIC_FIXTURE,
  SUM_METRIC_FIXTURE,
} from "@/mocks/metric-results-fixtures";
import {
  buildMetricCollectionRequest,
  entityObserved,
  filterCollectionToAvailable,
  filterCollectionToDeclaredDimensions,
  type NormalizedMetricResult,
  chunkEntityIds,
  entityChunkSize,
  forEntity,
  mergeNormalizedResults,
  normalizeMetricResult,
  normalizeMetricResults,
  projectComparison,
  projectPrimary,
  projectViews,
  resolveBucket,
  type MetricCollectionConfig,
} from "@/lib/metrics/collection";

const COLLECTION: MetricCollectionConfig = {
  metrics: [
    {
      key: "ai.accepted_lines",
      views: [
        { view: "period" },
        { view: "peer" },
        {
          view: "timeseries",
          bucket: "auto",
          dimensions: ["tool"],
          groupLimit: {
            count: 10,
            rank_by_metric: "ai.accepted_lines",
            include_remainder: true,
          },
        },
        { view: "breakdown", dimensions: ["tool"] },
      ],
    },
    {
      key: "ai.tool_acceptance_rate",
      views: [{ view: "period" }, { view: "peer" }],
    },
  ],
};

const RANGE = { from: "2026-06-01", to: "2026-06-30" };

describe("absence context", () => {
  it("retains person-scoped context across entity chunks", () => {
    const first = { person_id: "person-a", period_overlap: true, compare_to_overlap: false };
    const second = { person_id: "person-b", period_overlap: false, compare_to_overlap: true };
    const merged = mergeNormalizedResults([
      normalizeMetricResults([SUM_METRIC_FIXTURE], [first]),
      normalizeMetricResults([SUM_METRIC_FIXTURE], [second]),
    ]);
    const metric = merged.get("ai.accepted_lines")!;
    expect(forEntity(metric, "person-a").absence).toEqual(first);
    expect(forEntity(metric, "person-b").absence).toEqual(second);
    expect(forEntity(metric, "person-c").absence).toBeUndefined();
    expect(SUM_METRIC_FIXTURE).not.toHaveProperty("absenceContext");
  });

  it("keeps responses without confirmed absence context unchanged", () => {
    expect(normalizeMetricResults([SUM_METRIC_FIXTURE], [])).toEqual(
      normalizeMetricResults([SUM_METRIC_FIXTURE]),
    );
  });
});

describe("buildMetricCollectionRequest", () => {
  it("derives the wire request from the collection", () => {
    const request = buildMetricCollectionRequest(
      COLLECTION,
      { type: "person", ids: ["alice@example.com"] },
      RANGE
    );
    expect(request.entity).toEqual({
      type: "person",
      ids: ["alice@example.com"],
    });
    expect(request.metrics).toHaveLength(2);
    expect(request.metrics[0]?.views).toEqual([
      { view: "period" },
      { view: "peer" },
      {
        view: "timeseries",
        bucket: "week",
        dimensions: ["tool"],
        group_limit: {
          count: 10,
          rank_by_metric: "ai.accepted_lines",
          include_remainder: true,
        },
      },
      { view: "breakdown", dimensions: ["tool"] },
    ]);
  });

  it("omits the comparison window entirely when none was asked for", () => {
    const request = buildMetricCollectionRequest(
      COLLECTION,
      { type: "person", ids: ["alice@example.com"] },
      RANGE
    );
    expect("compare_to" in request).toBe(false);
  });

  it("carries the comparison window", () => {
    const request = buildMetricCollectionRequest(
      COLLECTION,
      { type: "person", ids: ["alice@example.com"] },
      RANGE,
      { from: "2026-05-01", to: "2026-05-31" }
    );
    expect(request.compare_to).toEqual({ from: "2026-05-01", to: "2026-05-31" });
  });
});

describe("a compared breakdown's row set", () => {
  const disjoint = (): Map<string, NormalizedMetricResult> =>
    new Map([
      [
        "ci.gate_pass_rate",
        {
          metric_key: "ci.gate_pass_rate",
          label: "Pass rate",
          unit: null,
          computation: "ratio",
          format: "percent",
          direction: "higher_is_better",
          breakdown: {
            view: "breakdown",
            dimensions: ["repository"],
            values: [
              {
                entity_id: "t",
                dimensions: [{ key: "repository", value: "org/a" }],
                value: null,
                present: true,
                compare_to: { value: null, present: false },
              },
              {
                entity_id: "t",
                dimensions: [{ key: "repository", value: "org/b" }],
                value: null,
                present: false,
                compare_to: { value: 20, present: true },
              },
            ],
          },
        } satisfies NormalizedMetricResult,
      ],
    ]);

  const repositories = (result: NormalizedMetricResult | undefined) =>
    result?.breakdown?.values.map((row) => row.dimensions[0]?.value);

  it("gives the comparison window only the groups it had", () => {
    const projected = projectComparison(disjoint()).get("ci.gate_pass_rate");
    expect(repositories(projected)).toEqual(["org/b"]);
    expect(projected?.breakdown?.values[0]?.value).toBe(20);
  });

  it("keeps a present group whose value is genuinely null", () => {
    const primary = projectPrimary(disjoint()).get("ci.gate_pass_rate");
    expect(repositories(primary)).toEqual(["org/a"]);
    expect(primary?.breakdown?.values[0]?.value).toBeNull();
  });

  it("leaves an uncompared response untouched", () => {
    const plain = new Map([
      [
        "git.commits",
        {
          metric_key: "git.commits",
          label: "Commits",
          unit: null,
          computation: "sum",
          format: "integer",
          direction: "higher_is_better",
          breakdown: {
            view: "breakdown",
            dimensions: ["repository"],
            values: [
              {
                entity_id: "t",
                dimensions: [{ key: "repository", value: "org/a" }],
                value: 0,
              },
            ],
          },
        } satisfies NormalizedMetricResult,
      ],
    ]);
    expect(projectPrimary(plain).get("git.commits")).toBe(plain.get("git.commits"));
  });
});

describe("projectComparison", () => {
  const windowed = (): Map<string, NormalizedMetricResult> =>
    new Map([
      [
        "git.commits",
        {
          metric_key: "git.commits",
          label: "Commits",
          unit: null,
          computation: "sum",
          format: "integer",
          direction: "higher_is_better",
          period: {
            view: "period",
            values: [{ entity_id: "a", value: 9, compare_to: 2 }],
          },
          peer: {
            view: "peer",
            values: [
              {
                entity_id: "a",
                target_value: 9,
                p25: 1,
                median: 5,
                p75: 8,
                min: 0,
                max: 10,
                n: 7,
              },
            ],
          },
        } satisfies NormalizedMetricResult,
      ],
    ]);

  it("reads the comparison window as the value", () => {
    expect(
      projectComparison(windowed()).get("git.commits")?.period?.values[0]?.value
    ).toBe(2);
  });

  it("drops the views the comparison window does not carry", () => {
    expect(projectComparison(windowed()).get("git.commits")?.peer).toBeUndefined();
  });

  it("leaves the source map untouched", () => {
    const source = windowed();
    projectComparison(source);
    expect(source.get("git.commits")?.period?.values[0]?.value).toBe(9);
  });
});

describe("projectViews", () => {
  it("derives a view subset without touching the source collection", () => {
    const projected = projectViews(COLLECTION, ["period", "peer"]);
    expect(
      projected.metrics.every((m) =>
        m.views.every((v) => v.view === "period" || v.view === "peer")
      )
    ).toBe(true);
    expect(COLLECTION.metrics[0]?.views).toHaveLength(4);
  });

  it("drops metrics whose views project to empty (backend rejects views: [])", () => {
    const chartOnly: MetricCollectionConfig = {
      metrics: [
        {
          key: "m.chart",
          views: [{ view: "timeseries", bucket: "auto" }],
        },
        { key: "m.full", views: [{ view: "period" }, { view: "peer" }] },
      ],
    };
    const projected = projectViews(chartOnly, ["period", "peer"]);
    expect(projected.metrics.map((m) => m.key)).toEqual(["m.full"]);
  });
});

describe("normalizeMetricResult forward-compat", () => {
  it("ignores unknown view kinds instead of crashing the collection", () => {
    const withUnknown = {
      ...SUM_METRIC_FIXTURE,
      views: [
        ...SUM_METRIC_FIXTURE.views,
        { view: "sparkline", points: [] } as never,
      ],
    };
    const normalized = normalizeMetricResult(withUnknown);
    expect(normalized.period).toBeDefined();
    expect(normalized.peer).toBeDefined();
  });
});

describe("normalizeMetricResult error views", () => {
  it("stores the error instead of warning, keeping the healthy views", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const withError = {
        ...SUM_METRIC_FIXTURE,
        views: [
          ...SUM_METRIC_FIXTURE.views,
          buildMetricErrorView({ code: "QUERY_TIMEOUT", message: "took too long" }),
        ],
      };
      const normalized = normalizeMetricResult(withError);
      expect(normalized.error).toEqual({
        code: "QUERY_TIMEOUT",
        message: "took too long",
      });
      expect(normalized.period).toBeDefined();
      expect(normalized.peer).toBeDefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the first error when several views failed", () => {
    const normalized = normalizeMetricResult({
      ...SUM_METRIC_FIXTURE,
      views: [
        buildMetricErrorView({ code: "RESOURCE_EXHAUSTED", message: "first" }),
        buildMetricErrorView({ code: "QUERY_FAILED", message: "second" }),
      ],
    });
    expect(normalized.error).toEqual({
      code: "RESOURCE_EXHAUSTED",
      message: "first",
    });
  });

  it("reads a not-ready view as no data yet rather than as a failure", () => {
    const normalized = normalizeMetricResult({
      ...SUM_METRIC_FIXTURE,
      views: [buildMetricNotReadyView()],
    });

    expect(normalized.notReady).toBe("SOURCE_RELATION_MISSING");
    expect(normalized.error).toBeUndefined();
  });
});

describe("row-limit chunking", () => {
  const PERIOD_PEER: MetricCollectionConfig = {
    metrics: Array.from({ length: 10 }, (_, i) => ({
      key: `m.${i}`,
      views: [{ view: "period" as const }, { view: "peer" as const }],
    })),
  };

  it("computes the per-request entity capacity from the view count", () => {
    expect(entityChunkSize(PERIOD_PEER)).toBe(225);
  });

  it("never asks for more people than the endpoint takes in one request", () => {
    const onePeriodMetric: MetricCollectionConfig = {
      metrics: [{ key: "git.commits", views: [{ view: "period" }] }],
    };

    expect(entityChunkSize(onePeriodMetric)).toBe(1000);
  });

  it("is not chunkable with bucket-projected views", () => {
    expect(entityChunkSize(COLLECTION)).toBeNull();
  });

  it("splits a 251-person roster into limit-safe chunks", () => {
    const ids = Array.from({ length: 251 }, (_, i) => `p${i}@x.com`);
    const chunks = chunkEntityIds(ids, entityChunkSize(PERIOD_PEER)!);
    expect(chunks).toHaveLength(2);
    expect(chunks.flat()).toHaveLength(251);
    for (const chunk of chunks) {
      expect(chunk.length * 20).toBeLessThanOrEqual(4500);
    }
  });

  it("merges chunked results back into one collection", () => {
    const a = normalizeMetricResults([SUM_METRIC_FIXTURE]);
    const bFixture = structuredClone(SUM_METRIC_FIXTURE);
    const periodView = bFixture.views[0];
    if (periodView?.view === "period") {
      periodView.values = [{ entity_id: "carol@example.com", value: 7 }];
    }
    const merged = mergeNormalizedResults([
      a,
      normalizeMetricResults([bFixture]),
    ]);
    const metric = merged.get("ai.accepted_lines")!;
    expect(metric.period?.values.map((v) => v.entity_id)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
    expect(a.get("ai.accepted_lines")?.period?.values).toHaveLength(2);
  });

  it("adopts a view from a later chunk when the accumulator lacks it", () => {
    const periodOnly = structuredClone(SUM_METRIC_FIXTURE);
    periodOnly.views = periodOnly.views.filter((v) => v.view === "period");
    const peerOnly = structuredClone(SUM_METRIC_FIXTURE);
    peerOnly.views = peerOnly.views.filter((v) => v.view === "peer");

    const merged = mergeNormalizedResults([
      normalizeMetricResults([periodOnly]),
      normalizeMetricResults([peerOnly]),
    ]);
    const metric = merged.get("ai.accepted_lines")!;
    expect(metric.period).toBeDefined();
    expect(metric.peer).toBeDefined();
  });

  it("keeps the accumulator's view when a later chunk omits it", () => {
    const full = normalizeMetricResults([SUM_METRIC_FIXTURE]);
    const peerOnly = structuredClone(SUM_METRIC_FIXTURE);
    peerOnly.views = peerOnly.views.filter((v) => v.view === "peer");

    const merged = mergeNormalizedResults([
      full,
      normalizeMetricResults([peerOnly]),
    ]);
    const metric = merged.get("ai.accepted_lines")!;
    expect(metric.period?.values.length).toBeGreaterThan(0);
    expect(metric.peer?.values.length ?? 0).toBeGreaterThan(1);
  });

  it("keeps a later chunk's error when the accumulator has none", () => {
    const healthy = normalizeMetricResults([SUM_METRIC_FIXTURE]);
    const failed = structuredClone(SUM_METRIC_FIXTURE);
    failed.views = [
      buildMetricErrorView({ code: "QUERY_FAILED", message: "chunk two failed" }),
    ];

    const merged = mergeNormalizedResults([
      healthy,
      normalizeMetricResults([failed]),
    ]);
    const metric = merged.get("ai.accepted_lines")!;
    expect(metric.error).toEqual({
      code: "QUERY_FAILED",
      message: "chunk two failed",
    });
    expect(metric.period?.values.length).toBeGreaterThan(0);
  });
});

describe("histogram view", () => {
  const HISTOGRAM_COLLECTION: MetricCollectionConfig = {
    metrics: [
      {
        key: "git.pr_cycle_time_h",
        views: [{ view: "period" }, { view: "peer" }, { view: "histogram" }],
      },
    ],
  };

  it("derives the histogram wire view", () => {
    const request = buildMetricCollectionRequest(
      HISTOGRAM_COLLECTION,
      { type: "person", ids: ["alice@example.com"] },
      RANGE
    );
    expect(request.metrics[0]?.views).toEqual([
      { view: "period" },
      { view: "peer" },
      { view: "histogram" },
    ]);
  });

  it("normalizes onto the histogram field", () => {
    const normalized = normalizeMetricResult(MEDIAN_METRIC_FIXTURE);
    expect(normalized.computation).toBe("median");
    expect(normalized.histogram?.values).toHaveLength(1);
  });

  it("slices bins for the entity and returns none for others", () => {
    const metric = normalizeMetricResults([MEDIAN_METRIC_FIXTURE]).get(
      "git.pr_cycle_time_h"
    )!;
    expect(forEntity(metric, "alice@example.com").histogram).toHaveLength(1);
    expect(
      forEntity(metric, "alice@example.com").histogram[0]?.bins.length
    ).toBeGreaterThan(0);
    expect(forEntity(metric, "bob@example.com").histogram).toHaveLength(0);
  });

  it("is not chunkable (single-entity drilldown view)", () => {
    expect(entityChunkSize(HISTOGRAM_COLLECTION)).toBeNull();
  });
});

describe("rollup view", () => {
  const ROLLUP_COLLECTION: MetricCollectionConfig = {
    metrics: [
      {
        key: "git.prs_merged",
        views: [
          {
            view: "rollup",
            dimensions: ["repository"],
            groupLimit: {
              count: 10,
              rank_by_metric: "git.prs_merged",
              include_remainder: true,
            },
          },
        ],
      },
    ],
  };

  it("derives the rollup wire view with its group limit", () => {
    const request = buildMetricCollectionRequest(
      ROLLUP_COLLECTION,
      { type: "person", ids: ["alice@example.com"] },
      RANGE
    );
    expect(request.metrics[0]?.views).toEqual([
      {
        view: "rollup",
        dimensions: ["repository"],
        group_limit: {
          count: 10,
          rank_by_metric: "git.prs_merged",
          include_remainder: true,
        },
      },
    ]);
  });

  it("normalizes onto the rollup field", () => {
    const normalized = normalizeMetricResult({
      ...SUM_METRIC_FIXTURE,
      views: [
        {
          view: "rollup",
          dimensions: ["repository"],
          values: [
            {
              dimensions: [
                { key: "repository", value: "r1", label: "org/repo" },
              ],
              value: 12,
              contributing_entity_count: 3,
            },
          ],
        },
      ],
    });
    expect(normalized.rollup?.values).toEqual([
      {
        dimensions: [{ key: "repository", value: "r1", label: "org/repo" }],
        value: 12,
        contributing_entity_count: 3,
      },
    ]);
  });

  it("is not chunkable — rollup rows carry no entity grain to merge on", () => {
    expect(entityChunkSize(ROLLUP_COLLECTION)).toBeNull();
  });
});

describe("unattributed view", () => {
  const UNATTRIBUTED_COLLECTION: MetricCollectionConfig = {
    metrics: [{ key: "tasks.closed", views: [{ view: "unattributed" }] }],
  };

  it("asks for the share in one request that never chunks", () => {
    const request = buildMetricCollectionRequest(
      UNATTRIBUTED_COLLECTION,
      { type: "person", ids: ["alice@example.com"] },
      RANGE
    );

    expect(request.metrics[0]?.views).toEqual([{ view: "unattributed" }]);
    expect(entityChunkSize(UNATTRIBUTED_COLLECTION)).toBeNull();
  });

  it("normalizes onto the unattributed field", () => {
    const normalized = normalizeMetricResult({
      ...SUM_METRIC_FIXTURE,
      views: [{ view: "unattributed", value: 3 }],
    });

    expect(normalized.unattributed).toEqual({ view: "unattributed", value: 3 });
  });
});

describe("resolveBucket", () => {
  it("keeps explicit buckets", () => {
    expect(resolveBucket("month", RANGE)).toBe("month");
  });

  it("tiers auto: day through 7d, week below 1y, month from 1y", () => {
    expect(
      resolveBucket("auto", { from: "2026-06-01", to: "2026-06-07" })
    ).toBe("day");
    expect(
      resolveBucket("auto", { from: "2026-06-01", to: "2026-06-08" })
    ).toBe("week");
    expect(
      resolveBucket("auto", { from: "2025-07-22", to: "2026-07-20" })
    ).toBe("week");
    expect(
      resolveBucket("auto", { from: "2025-07-21", to: "2026-07-20" })
    ).toBe("month");
  });
});

describe("normalizeMetricResult", () => {
  it("maps views onto per-view fields and keeps wire metadata", () => {
    const normalized = normalizeMetricResult(SUM_METRIC_FIXTURE);
    expect(normalized.computation).toBe("sum");
    expect(normalized.explanation).toBeDefined();
    expect(normalized.period).toBeDefined();
    expect(normalized.peer).toBeDefined();
    expect(normalized.timeseries).toBeDefined();
    expect(normalized.breakdown).toBeDefined();
    expect("views" in normalized).toBe(false);
  });

  it("carries ratio scale and null unit", () => {
    const normalized = normalizeMetricResult(RATIO_METRIC_FIXTURE);
    expect(normalized.scale).toBe(100);
    expect(normalized.unit).toBeNull();
  });
});

describe("forEntity", () => {
  const byKey = normalizeMetricResults([SUM_METRIC_FIXTURE]);
  const metric = byKey.get("ai.accepted_lines")!;

  it("slices every view for one entity", () => {
    const data = forEntity(metric, "alice@example.com");
    expect(data.value).toBe(1240);
    expect(data.peer?.n).toBe(12);
    expect(data.bucket).toBe("day");
    expect(data.series).toHaveLength(2);
    expect(data.breakdown).toHaveLength(2);
  });

  it("returns empty slices for unknown entities", () => {
    const data = forEntity(metric, "nobody@example.com");
    expect(data.value).toBeNull();
    expect(data.peer).toBeNull();
    expect(data.series).toHaveLength(0);
    expect(data.breakdown).toHaveLength(0);
  });

  it("zero-fills sums for requested-but-inactive entities (backend contract)", () => {
    expect(forEntity(metric, "bob@example.com").value).toBe(0);
  });

  it("keeps a null period value distinct from a missing entity", () => {
    const ratio = normalizeMetricResults([RATIO_METRIC_FIXTURE]).get(
      "ai.tool_acceptance_rate"
    )!;
    expect(forEntity(ratio, "bob@example.com").value).toBeNull();
    expect(forEntity(ratio, "nobody@example.com").value).toBeNull();
  });
});

describe("entityObserved", () => {
  const withPeer = (target: number | null, value: number | null) =>
    ({
      metric_key: "m",
      label: "M",
      unit: null,
      computation: "sum",
      format: "integer",
      direction: "higher_is_better",
      period: { view: "period", values: [{ entity_id: "a@x", value }] },
      peer: {
        view: "peer",
        values: [{ entity_id: "a@x", target_value: target, median: 5, n: 9 }],
      },
    }) as unknown as NormalizedMetricResult;

  it("treats a null peer target as unobserved, whatever the period value says", () => {
    expect(entityObserved(withPeer(null, 0), "a@x")).toBe(false);
  });

  it("treats a ZERO peer target as observed — a measured zero is data", () => {
    expect(entityObserved(withPeer(0, 0), "a@x")).toBe(true);
  });

  it("falls back to a non-zero period value when there is no peer row", () => {
    const noPeer = {
      metric_key: "m",
      label: "M",
      unit: null,
      computation: "sum",
      format: "integer",
      direction: "higher_is_better",
      period: { view: "period", values: [{ entity_id: "a@x", value: 7 }] },
    } as unknown as NormalizedMetricResult;
    expect(entityObserved(noPeer, "a@x")).toBe(true);
  });

  it("does not count a zero-filled period value as observation without a peer row", () => {
    const noPeer = {
      metric_key: "m",
      label: "M",
      unit: null,
      computation: "sum",
      format: "integer",
      direction: "higher_is_better",
      period: { view: "period", values: [{ entity_id: "a@x", value: 0 }] },
    } as unknown as NormalizedMetricResult;
    expect(entityObserved(noPeer, "a@x")).toBe(false);
  });
});

describe("filterCollectionToDeclaredDimensions", () => {
  const REPO = [{ dimension: "repository", values: ["src:acme/api"] }];
  const declared = new Map<string, ReadonlySet<string>>([
    ["git.commits", new Set(["repository", "hour_block"])],
    ["git.prs_merged", new Set(["repository"])],
    ["tasks.closed", new Set(["project"])],
  ]);
  const scoped: MetricCollectionConfig = {
    metrics: [
      { key: "git.commits", filters: REPO, views: [{ view: "period" }] },
      { key: "tasks.closed", filters: REPO, views: [{ view: "period" }] },
    ],
  };

  it("drops a metric narrowed by a dimension it does not declare", () => {
    const out = filterCollectionToDeclaredDimensions(scoped, declared);
    expect(out.metrics.map((m) => m.key)).toEqual(["git.commits"]);
  });

  it("keeps a metric that asks for no dimension at all", () => {
    const plain: MetricCollectionConfig = {
      metrics: [{ key: "tasks.closed", views: [{ view: "period" }] }],
    };
    expect(filterCollectionToDeclaredDimensions(plain, declared)).toBe(plain);
  });

  it("needs EVERY named dimension, not just one of them", () => {
    const both: MetricCollectionConfig = {
      metrics: [
        {
          key: "git.prs_merged",
          filters: [
            { dimension: "repository", values: ["src:acme/api"] },
            { dimension: "hour_block", values: ["08"] },
          ],
          views: [{ view: "period" }],
        },
      ],
    };
    expect(filterCollectionToDeclaredDimensions(both, declared).metrics).toEqual(
      [],
    );
  });

  it("drops a metric the catalog does not describe at all", () => {
    const unknown: MetricCollectionConfig = {
      metrics: [
        { key: "git.mystery", filters: REPO, views: [{ view: "period" }] },
      ],
    };
    expect(
      filterCollectionToDeclaredDimensions(unknown, declared).metrics,
    ).toEqual([]);
  });

  it("judges each entry by its OWN filters, not by the first with that key", () => {
    const twice: MetricCollectionConfig = {
      metrics: [
        { key: "git.commits", filters: REPO, views: [{ view: "period" }] },
        {
          key: "git.commits",
          filters: [{ dimension: "team", values: ["platform"] }],
          views: [{ view: "peer" }],
        },
      ],
    };
    const out = filterCollectionToDeclaredDimensions(twice, declared);
    expect(out.metrics).toEqual([twice.metrics[0]]);
  });

  it("drops nothing while the catalog is unknown", () => {
    expect(filterCollectionToDeclaredDimensions(scoped, null)).toBe(scoped);
  });

  it("returns the SAME object when every filter is supported", () => {
    const fine: MetricCollectionConfig = {
      metrics: [
        { key: "git.commits", filters: REPO, views: [{ view: "period" }] },
      ],
    };
    expect(filterCollectionToDeclaredDimensions(fine, declared)).toBe(fine);
  });
});

describe("filterCollectionToAvailable", () => {
  const collection: MetricCollectionConfig = {
    metrics: [
      { key: "git.commits", views: [{ view: "period" }] },
      { key: "tasks.closed_task", views: [{ view: "period" }] },
      { key: "ai.cost", views: [{ view: "period" }] },
    ],
  };

  it("drops a key the catalog does not offer, keeping the rest", () => {
    const out = filterCollectionToAvailable(
      collection,
      new Set(["git.commits", "ai.cost"]),
    );
    expect(out.metrics.map((m) => m.key)).toEqual(["git.commits", "ai.cost"]);
  });

  it("returns the SAME object when every key is available", () => {
    const all = new Set(["git.commits", "tasks.closed_task", "ai.cost"]);
    expect(filterCollectionToAvailable(collection, all)).toBe(collection);
  });

  it("drops nothing while the catalog is unknown", () => {
    expect(filterCollectionToAvailable(collection, null)).toBe(collection);
  });

  it("can empty the collection when the catalog offers none of it", () => {
    expect(filterCollectionToAvailable(collection, new Set()).metrics).toEqual([]);
  });
});
