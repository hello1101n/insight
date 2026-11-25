import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EvidenceDialogContext } from "@/components/metric-evidence-context";
import { MetricHistogram } from "@/components/widgets/metric-views/metric-histogram";
import {
  normalizeMetricResults,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";
import type { MetricResult } from "@/api/metric-results-client";

// WORKAROUND: Recharts draws nothing without a real layout, so the chart reports the rows it was handed.
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BarChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="plot" data-rows={JSON.stringify(data)} />
  ),
}));

vi.mock("@gears-frontx/ui-kit", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ChartContainer: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

function medianMetric(
  bins: Array<{ lo: number; hi: number; count: number }>,
  opts: { ownMedian?: number | null; peerMedian?: number | null } = {},
): NormalizedMetricResult {
  const { ownMedian = 20, peerMedian = 24 } = opts;
  const result: MetricResult = {
    metric_key: "git.pr_cycle_time_h",
    label: "PR cycle time",
    unit: "h",
    format: "decimal",
    direction: "lower_is_better",
    computation: "median",
    views: [
      { view: "period", values: [{ entity_id: "me@x.com", value: ownMedian }] },
      {
        view: "peer",
        values: [
          {
            entity_id: "me@x.com",
            target_value: ownMedian,
            p25: null,
            median: peerMedian,
            p75: null,
            min: null,
            max: null,
            n: 10,
          },
        ],
      },
      { view: "histogram", values: [{ entity_id: "me@x.com", bins }] },
    ],
  };
  return normalizeMetricResults([result]).get("git.pr_cycle_time_h")!;
}

const BINS = [
  { lo: 0, hi: 10, count: 3 },
  { lo: 10, hi: 20, count: 5 },
  { lo: 20, hi: 30, count: 2 },
  { lo: 30, hi: 40, count: 1 },
];

describe("MetricHistogram", () => {
  it("renders the label (no 'distribution' word) and direction", () => {
    render(<MetricHistogram metric={medianMetric(BINS)} entityId="me@x.com" />);
    expect(screen.getByText("PR cycle time")).toBeInTheDocument();
    expect(
      screen.queryByText("PR cycle time distribution"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Lower is better/)).toBeInTheDocument();
  });

  it("names the peer median it colors against", () => {
    render(<MetricHistogram metric={medianMetric(BINS)} entityId="me@x.com" />);
    expect(screen.getByText(/vs peer median/)).toBeInTheDocument();
  });

  it("drops the peer comparison when there is no peer median", () => {
    render(
      <MetricHistogram
        metric={medianMetric(BINS, { peerMedian: null })}
        entityId="me@x.com"
      />,
    );
    expect(screen.queryByText("Better than peers")).not.toBeInTheDocument();
    expect(screen.queryByText(/vs peer median/)).not.toBeInTheDocument();
  });

  it.each([
    {
      rule: "puts a peer median on the last bin's upper edge in that bin, which is closed at the top",
      peerMedian: 40,
      holder: 3,
    },
    {
      rule: "puts a peer median on a middle bin's upper edge in the next bin, since the rest are half-open",
      peerMedian: 20,
      holder: 2,
    },
  ])("$rule", ({ peerMedian, holder }) => {
    render(
      <MetricHistogram
        metric={medianMetric(BINS, { peerMedian })}
        entityId="me@x.com"
      />,
    );
    const rows = JSON.parse(screen.getByTestId("plot").dataset.rows!) as {
      status: string;
    }[];
    const neutral = rows.flatMap((row, index) =>
      row.status === "neutral" ? [index] : [],
    );
    expect(neutral, `should hold ${peerMedian} in bin ${holder} alone`).toEqual([
      holder,
    ]);
  });

  it("shows the empty state for an entity with no bins", () => {
    render(<MetricHistogram metric={medianMetric([])} entityId="me@x.com" />);
    expect(screen.getByText("No values in this period")).toBeInTheDocument();
  });

  it("shows the empty state for an entity absent from the view", () => {
    render(<MetricHistogram metric={medianMetric(BINS)} entityId="nobody@x.com" />);
    expect(screen.getByText("No values in this period")).toBeInTheDocument();
  });

  describe("supporting data", () => {
    function drillable(
      metric: NormalizedMetricResult
    ): NormalizedMetricResult {
      return {
        ...metric,
        drilldown: { granularity: ["event"] },
        selection: {
          metric_key: "git.pr_cycle_time_h",
          entity: { type: "person", ids: ["me@x.com"] },
          period: { from: "2026-07-01", to: "2026-07-31" },
          filters: [],
        },
      };
    }

    function renderWithEvidence(metric: NormalizedMetricResult) {
      const openEvidenceTargets = vi.fn();
      render(
        <EvidenceDialogContext.Provider
          value={{
        openEvidence: vi.fn(),
        openEvidenceTargets,
        openEvidencePeople: vi.fn(),
      }}
        >
          <MetricHistogram metric={metric} entityId="me@x.com" />
        </EvidenceDialogContext.Provider>
      );
      return openEvidenceTargets;
    }

    it("opens the records behind the distribution", async () => {
      const user = userEvent.setup();
      const openEvidenceTargets = renderWithEvidence(
        drillable(medianMetric(BINS))
      );

      await user.click(
        screen.getByRole("button", { name: "More actions for PR cycle time" })
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "View supporting data" })
      );
      expect(openEvidenceTargets).toHaveBeenCalledWith(
        [
          {
            selection: expect.objectContaining({
              metric_key: "git.pr_cycle_time_h",
            }),
            label: "PR cycle time",
          },
        ],
        { activeMetricKey: "git.pr_cycle_time_h" }
      );
    });

    it("offers them on an empty period too, since the metric is still drillable", () => {
      renderWithEvidence(drillable(medianMetric([])));
      expect(
        screen.getByRole("button", { name: "More actions for PR cycle time" })
      ).toBeInTheDocument();
    });

    it("offers nothing for a metric that declares no drilldown", () => {
      renderWithEvidence(medianMetric(BINS));
      expect(
        screen.queryByRole("button", { name: /More actions/ })
      ).not.toBeInTheDocument();
    });
  });
});
