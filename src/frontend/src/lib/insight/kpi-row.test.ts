import { describe, expect, it } from "vitest";

import type { MetricResult } from "@/api/metric-results-client";
import { metricKpiTiles } from "@/lib/insight/kpi-row";
import { normalizeMetricResults } from "@/lib/metrics/collection";

function metricResult(
  key: string,
  value: number | null,
  overrides: Partial<MetricResult> = {}
): MetricResult {
  return {
    metric_key: key,
    label: key,
    unit: null,
    format: "integer",
    direction: "higher_is_better",
    computation: "sum",
    views: [
      { view: "period", values: [{ entity_id: "me@x.com", value }] },
      {
        view: "peer",
        values: [
          {
            entity_id: "me@x.com",
            target_value: value,
            p25: 5,
            median: 10,
            p75: 15,
            min: 0,
            max: 30,
            n: 8,
          },
        ],
      },
    ],
    ...overrides,
  } as MetricResult;
}

describe("metricKpiTiles", () => {
  it.each([
    [true, false, "Time off in this period"],
    [false, true, "Time off in previous period"],
    [true, true, "Time off in both periods"],
  ])("keeps numbers but neutralizes leave-affected trends (%s, %s)", (period, previous, label) => {
    const current = normalizeMetricResults([metricResult("git.default_branch_commits", 3)], [
      { person_id: "me@x.com", period_overlap: period, compare_to_overlap: previous },
    ]);
    const before = normalizeMetricResults([metricResult("git.default_branch_commits", 100)]);
    const [tile] = metricKpiTiles(current, before, "me@x.com");
    expect(tile?.value).toBe("3");
    expect(tile?.delta).toMatchObject({ text: "-97%", status: "neutral" });
    expect(tile?.medianLabel).toBe("median 10");
    expect(tile?.gapText).toBeTruthy();
    expect(tile?.absenceLabel).toBe(label);
  });

  it("builds display-ready tiles with rank status and delta", () => {
    const byKey = normalizeMetricResults([
      metricResult("ai.active_days", 14),
      metricResult("ai.accepted_lines", 900),
    ]);
    const previous = normalizeMetricResults([
      metricResult("ai.active_days", 12),
      metricResult("ai.accepted_lines", 1000),
    ]);
    const tiles = metricKpiTiles(byKey, previous, "me@x.com");
    expect(tiles.map((t) => t.key)).toEqual([
      "ai.active_days",
      "ai.accepted_lines",
    ]);
    const active = tiles[0]!;
    expect(active.value).toBe("14");
    expect(active.gapStatus).toBe("neutral");
    expect(active.delta?.text).toBe("+17%");
    expect(active.medianLabel).toBe("median 10");
    expect(active.groupId).toBe("ai_adoption");
    const lines = tiles[1]!;
    expect(lines.gapStatus).toBe("good");
    expect(lines.delta).toEqual({ text: "-10%", status: "bad", down: true });
  });

  it("renders neutral when the backend suppressed the peer stats", () => {
    const result = metricResult("ai.active_days", 14);
    const peerView = result.views[1];
    if (peerView?.view === "peer" && peerView.values[0]) {
      Object.assign(peerView.values[0], {
        p25: null,
        median: null,
        p75: null,
        min: null,
        max: null,
        n: 3,
      });
    }
    const tiles = metricKpiTiles(
      normalizeMetricResults([result]),
      null,
      "me@x.com"
    );
    expect(tiles[0]?.gapStatus).toBe("neutral");
    expect(tiles[0]?.medianLabel).toBeNull();
  });

  it("gives no slot to a metric this person is not measured on", () => {
    const result = metricResult("ai.active_days", 0);
    const peerView = result.views[1];
    if (peerView?.view === "peer" && peerView.values[0]) {
      peerView.values[0].target_value = null;
    }
    const tiles = metricKpiTiles(
      normalizeMetricResults([result]),
      null,
      "me@x.com"
    );
    expect(tiles).toEqual([]);
  });

  it("KEEPS the slot for a measured zero — that is a finding, not a gap", () => {
    const result = metricResult("ai.active_days", 0);
    const tiles = metricKpiTiles(
      normalizeMetricResults([result]),
      null,
      "me@x.com"
    );
    expect(tiles.map((t) => t.key)).toEqual(["ai.active_days"]);
  });

  it("computes pp deltas for percent-ratio tiles (time outside meetings)", () => {
    const current = metricResult("collab.focus_time_pct", 77, {
      metric_key: "collab.focus_time_pct",
      format: "percent",
      computation: "ratio",
      scale: 100,
    } as Partial<MetricResult>);
    const previous = metricResult("collab.focus_time_pct", 72, {
      format: "percent",
      computation: "ratio",
      scale: 100,
    } as Partial<MetricResult>);
    const tiles = metricKpiTiles(
      normalizeMetricResults([current]),
      normalizeMetricResults([previous]),
      "me@x.com"
    );
    expect(tiles[0]?.delta?.text).toBe("+5 pp");
  });

  it.each([
    { previous: 10, current: 10, delta: { text: "±0%", status: "neutral", down: false } },
    { previous: 1000, current: 1004, delta: { text: "±0%", status: "neutral", down: false } },
    { previous: 1000, current: 996, delta: { text: "±0%", status: "neutral", down: false } },
    { previous: 0, current: 0, delta: { text: "±0%", status: "neutral", down: false } },
    { previous: null, current: 10, delta: null },
    { previous: 10, current: 20, delta: { text: "2×", status: "good", down: false } },
  ])(
    "says unchanged only when an earlier value exists: $previous -> $current",
    ({ previous, current, delta }) => {
      const tiles = metricKpiTiles(
        normalizeMetricResults([metricResult("git.default_branch_commits", current)]),
        normalizeMetricResults([metricResult("git.default_branch_commits", previous)]),
        "me@x.com"
      );
      expect(tiles[0]?.delta, `previous ${previous}, current ${current}`).toEqual(delta);
    }
  );

  it.each([
    { previous: 72, current: 72 },
    { previous: 72.2, current: 71.9 },
  ])(
    "says unchanged in points for a percent ratio that did not move: $previous -> $current",
    ({ previous, current }) => {
      const percentRatio = {
        format: "percent",
        computation: "ratio",
        scale: 100,
      } as Partial<MetricResult>;
      const tiles = metricKpiTiles(
        normalizeMetricResults([
          metricResult("collab.focus_time_pct", current, percentRatio),
        ]),
        normalizeMetricResults([
          metricResult("collab.focus_time_pct", previous, percentRatio),
        ]),
        "me@x.com"
      );
      expect(tiles[0]?.delta, `previous ${previous}, current ${current}`).toEqual({
        text: "0 pp",
        status: "neutral",
        down: false,
      });
    }
  );
});

describe("one finding, one mark", () => {
  it("puts the peer verdict on the line that states the comparison", () => {
    const result = metricResult("ai.active_days", 2);
    const tiles = metricKpiTiles(
      normalizeMetricResults([result]),
      null,
      "me@x.com"
    );
    expect(tiles[0]?.gapStatus).toBe("bad");
    expect(tiles[0]?.gapText).not.toBeNull();
  });
});
