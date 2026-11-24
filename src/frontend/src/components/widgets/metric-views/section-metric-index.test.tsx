// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MetricResult } from "@/api/metric-results-client";
import { SectionMetricIndex } from "@/components/widgets/metric-views/section-metric-index";
import { normalizeMetricResults } from "@/lib/metrics/collection";

const ME = "019e27bc-dec0-7626-81a9-c5524662a6a9";

function metric(
  key: string,
  label: string,
  value: number | null
): MetricResult {
  return {
    metric_key: key,
    label,
    unit: null,
    format: "integer",
    computation: "sum",
    direction: "higher_is_better",
    views: [{ view: "period", values: [{ entity_id: ME, value }] }],
  } as MetricResult;
}

const RESULTS = [
  metric("collab.zeta", "Zeta", 3),
  metric("collab.alpha", "Alpha", 1),
  metric("collab.mid", "Mid", null),
];
const COLLECTION = {
  metrics: RESULTS.map((r) => ({ key: r.metric_key, views: [] })),
};

function renderIndex(shown: string[] = []) {
  return render(
    <SectionMetricIndex
      collection={COLLECTION}
      byKey={normalizeMetricResults(RESULTS)}
      entityId={ME}
      shown={new Set(shown)}
    />
  );
}

describe("SectionMetricIndex", () => {
  it("lists what the section measures in alphabetical order", () => {
    renderIndex();
    const names = screen.getAllByRole("term").map((n) => n.textContent);
    expect(names).toEqual(["Alpha", "Zeta"]);
  });

  it("leaves out a metric that holds nothing", () => {
    renderIndex();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("leaves out what the section already drew", () => {
    renderIndex(["collab.alpha"]);
    const names = screen.getAllByRole("term").map((n) => n.textContent);
    expect(names).toEqual(["Zeta"]);
  });

  it("renders nothing when the section drew everything that reads", () => {
    const { container } = renderIndex(["collab.alpha", "collab.zeta"]);
    expect(container).toBeEmptyDOMElement();
  });
});
