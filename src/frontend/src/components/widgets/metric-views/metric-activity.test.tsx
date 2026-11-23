// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MetricEvidenceSelection } from "@/api/metric-drilldown-client";
import type { MetricResult } from "@/api/metric-results-client";
import { normalizeMetricResults } from "@/lib/metrics/collection";

const detail = vi.hoisted(() => ({
  state: {
    isPending: false,
    isError: false,
    data: undefined as unknown,
    refetch: () => {},
  },
  calls: [] as unknown[],
  collectedFrom: null as string | null,
  collectedThrough: null as string | null,
  settledThrough: null as string | null,
}));
vi.mock("@/queries/metric-detail", () => ({
  DETAIL_LIMIT: 200,
  useMetricDetail: (selection: unknown, enabled?: boolean) => {
    detail.calls.push({ selection, enabled });
    return detail.state;
  },
}));

const series = vi.hoisted(() => ({
  state: {
    isPending: false,
    isError: false,
    data: undefined as unknown,
    refetch: () => {},
  },
  notReady: false,
  calls: [] as unknown[],
}));
vi.mock("@/queries/metric-day-series", () => ({
  useMetricDaySeries: (selection: unknown, enabled?: boolean) => {
    series.calls.push({ selection, enabled });
    return {
      ...series.state,
      data: series.state.data
        ? { readings: series.state.data, notReady: series.notReady }
        : undefined,
    };
  },
}));

const declared = vi.hoisted(() => ({
  byMetricKey: new Map<string, ReadonlySet<string>>(),
}));
// WORKAROUND: a second `vi.mock` of the same specifier replaces the first,
// so this one mock serves both hooks.
vi.mock("@/queries/metric-definitions", async () => {
  const { withTypeDimension } = await import("@/lib/metrics/provider-links");
  return {
    useCollectionBoundary: () => ({
      collectedFrom: detail.collectedFrom,
      collectedThrough: detail.collectedThrough,
      settledThrough: detail.settledThrough,
    }),
    useTypedEvidenceSelection: (base: MetricEvidenceSelection | null) =>
      base &&
      withTypeDimension(base, declared.byMetricKey.get(base.metric_key)),
  };
});

import { MetricActivity } from "./metric-activity";

const ME = "019e27bc-dec0-7626-81a9-c5524662a6a9";

function reading(date: string, value: number) {
  return { date, value, numerator: null, denominator: null };
}

function metric(
  key: string,
  granularity: string[] | null,
  value: number | null,
  over: Partial<MetricResult> = {}
) {
  const result = {
    metric_key: key,
    label: key === "git.commits" ? "Commits" : "Chat Messages Sent",
    description: "what this counts",
    unit: key === "git.commits" ? "commits" : "messages",
    format: "integer",
    computation: "sum",
    direction: "higher_is_better",
    views: [{ view: "period", values: [{ entity_id: ME, value }] }],
    selection: {
      metric_key: key,
      entity: { type: "person", ids: [ME] },
      period: { from: "2026-03-01", to: "2026-03-05" },
      filters: [],
    },
    ...(granularity ? { drilldown: { granularity } } : {}),
    ...over,
  } as unknown as MetricResult;
  return normalizeMetricResults([result]).get(key)!;
}

function draw(m: ReturnType<typeof metric>) {
  return render(
    <MetricActivity
      metric={m}
      previous={null}
      entityId={ME}
      periodNoun="month"
    />
  );
}

beforeEach(() => {
  declared.byMetricKey = new Map();
  detail.calls = [];
  detail.collectedFrom = null;
  detail.collectedThrough = null;
  detail.settledThrough = null;
  detail.state = {
    isPending: false,
    isError: false,
    data: undefined,
    refetch: () => {},
  };
  series.calls = [];
  series.notReady = false;
  series.state = {
    isPending: false,
    isError: false,
    data: undefined,
    refetch: () => {},
  };
});

describe("MetricActivity", () => {
  it("says a metric offers no detail rather than leaving a hole", () => {
    draw(metric("git.commits", null, 14));
    expect(screen.getByText(/reports a period total only/)).toBeInTheDocument();
  });

  it("does not ask for detail a metric cannot give", () => {
    draw(metric("git.commits", null, 14));
    expect(detail.calls).toHaveLength(1);
    expect((detail.calls[0] as { enabled: boolean }).enabled).toBe(false);
  });

  it("lists the things themselves at event grain", () => {
    detail.state.data = {
      columns: [],
      rows: [
        {
          values: {
            date: "2026-03-04",
            title: "Fix the thing\n\nbody",
            repository: "example/app",
            ref: "abc",
          },
          links: {
            title: "https://git.example/example/app/commit/abc",
            repository: "https://git.example/example/app",
          },
        },
        {
          values: {
            date: "2026-03-02",
            title: "Another change",
            repository: "example/app",
            ref: "def",
          },
        },
      ],
    };
    draw(metric("git.commits", ["event"], 14));
    const rows = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(rows[0]).toContain("Fix the thing");
    expect(rows[0]).not.toContain("body");
    expect(rows[1]).toContain("Another change");
    expect(screen.getByRole("link", { name: "Fix the thing" })).toHaveAttribute(
      "href",
      "https://git.example/example/app/commit/abc"
    );
  });

  it("names the kind of issue beside each one", () => {
    declared.byMetricKey.set("tasks.closed", new Set(["source", "type"]));
    detail.state.data = {
      columns: [],
      rows: [
        {
          values: {
            date: "2026-03-04",
            title: "Login fails on retry",
            ref: "example/app#12",
            type: "Bug",
          },
        },
      ],
    };
    draw(metric("tasks.closed", ["event"], 1));
    const row = screen.getAllByRole("listitem")[0]?.textContent ?? "";
    expect(row).toContain("Bug");
    expect(row).toContain("Login fails on retry");
    const asked = detail.calls.at(-1) as {
      selection: { display_dimensions: string[] };
    };
    expect(asked.selection.display_dimensions).toContain("type");
  });

  it("spends no width on a type where the records have none", () => {
    detail.state.data = {
      columns: [],
      rows: [
        {
          values: {
            date: "2026-03-04",
            title: "Fix the thing",
            repository: "example/app",
            ref: "abc",
          },
        },
      ],
    };
    draw(metric("git.commits", ["event"], 1));
    expect(screen.getAllByRole("listitem")[0]?.textContent).not.toContain("—");
  });

  it("draws days at counter grain, and names the days with no reading", () => {
    series.state.data = [
      reading("2026-03-01", 4),
      reading("2026-03-03", 2),
      reading("2026-03-05", 0),
    ];
    const { container } = draw(
      metric("collab.messages_sent", ["source_summary"], 6)
    );
    expect(screen.getByText(/2 days with no reading/)).toBeInTheDocument();
    expect(container.querySelector("li")).toBeNull();
  });

  it("separates the days nobody collected from the days that were quiet", () => {
    detail.collectedThrough = "2026-03-03";
    series.state.data = [reading("2026-03-01", 4), reading("2026-03-03", 2)];
    draw(metric("collab.messages_sent", ["source_summary"], 6));
    expect(screen.getByText(/2 days not collected yet/)).toBeInTheDocument();
    expect(screen.getByText(/1 day with no reading/)).toBeInTheDocument();
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toMatch(/1 day has no reading/);
    expect(label).toMatch(/2 days are not collected yet/);
  });

  it("says a day is older than the data rather than calling it empty", () => {
    detail.collectedFrom = "2026-03-03";
    detail.collectedThrough = "2026-03-05";
    series.state.data = [reading("2026-03-03", 4)];
    draw(metric("collab.messages_sent", ["source_summary"], 4));
    expect(
      screen.getByText(/2 days before available data/)
    ).toBeInTheDocument();
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toMatch(/2 days are before available data/);
    expect(label).toMatch(/2 days have no reading/);
  });

  it("marks the days the supplier may still revise without hiding their figures", () => {
    detail.collectedThrough = "2026-03-03";
    detail.settledThrough = "2026-03-01";
    series.state.data = [
      reading("2026-03-01", 4),
      reading("2026-03-02", 3),
      reading("2026-03-03", 2),
    ];
    draw(metric("collab.messages_sent", ["source_summary"], 6));
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toMatch(/2 days may still change/);
    expect(screen.getByText(/2 days not collected yet/)).toBeInTheDocument();
    expect(screen.getByText(/2 days may still change/)).toBeInTheDocument();
  });

  it("states coverage and settlement together rather than choosing between them", () => {
    detail.collectedFrom = "2026-03-02";
    detail.collectedThrough = "2026-03-05";
    detail.settledThrough = "2026-03-03";
    series.state.data = [
      reading("2026-03-02", 4),
      reading("2026-03-04", 3),
      reading("2026-03-05", 2),
    ];
    draw(metric("collab.messages_sent", ["source_summary"], 9));
    const caption = screen.getByText(/before available data/).textContent ?? "";
    expect(caption).toMatch(/1 day before available data/);
    expect(caption).toMatch(/1 day with no reading/);
    expect(caption).toMatch(/2 may still change/);
  });

  it("keeps both ends of coverage when the period overruns the data on both sides", () => {
    detail.collectedFrom = "2026-03-02";
    detail.collectedThrough = "2026-03-04";
    series.state.data = [reading("2026-03-02", 4)];
    draw(metric("collab.messages_sent", ["source_summary"], 4));
    const caption = screen.getByText(/before available data/).textContent ?? "";
    expect(caption).toMatch(/1 day before available data/);
    expect(caption).toMatch(/1 not collected yet/);
  });

  it("does not let the denominator displace a coverage or settlement fact", () => {
    detail.collectedThrough = "2026-03-04";
    detail.settledThrough = "2026-03-02";
    series.state.data = [
      { date: "2026-03-01", value: 75, numerator: 6, denominator: 8 },
      { date: "2026-03-03", value: 87.5, numerator: 7, denominator: 8 },
    ];
    draw(
      metric("collab.focus_time_pct", ["derived_population"], 81, {
        computation: "ratio",
        format: "percent",
        scale: 100,
        unit: null,
      })
    );
    const caption = screen.getByText(/not collected yet/).textContent ?? "";
    expect(caption).toMatch(/1 day not collected yet/);
    expect(caption).toMatch(/may still change/);
    expect(caption).not.toMatch(/measured against/);
  });

  it("names a constant denominator, because that is what a share is argued with", () => {
    series.state.data = [
      { date: "2026-03-01", value: 75, numerator: 6, denominator: 8 },
      { date: "2026-03-02", value: 87.5, numerator: 7, denominator: 8 },
    ];
    draw(
      metric("collab.focus_time_pct", ["derived_population"], 81, {
        computation: "ratio",
        format: "percent",
        scale: 100,
        unit: null,
      })
    );
    expect(screen.getByText(/measured against 8 per day/)).toBeInTheDocument();
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toMatch(/busiest 2 Mar — 88% of 8/);
  });

  it("offers a retry when the list of things could not be loaded", () => {
    detail.state.isError = true;
    draw(metric("git.commits", ["event"], 3));
    expect(
      screen.getByRole("button", { name: /try again/i })
    ).toBeInTheDocument();
  });

  it("reads one source per grain and never both", () => {
    draw(metric("collab.messages_sent", ["source_summary"], 6));
    expect((detail.calls.at(-1) as { enabled: boolean }).enabled).toBe(false);
    expect((series.calls.at(-1) as { enabled: boolean }).enabled).toBe(true);

    detail.calls = [];
    series.calls = [];
    draw(metric("git.commits", ["event"], 3));
    expect((detail.calls.at(-1) as { enabled: boolean }).enabled).toBe(true);
    expect((series.calls.at(-1) as { enabled: boolean }).enabled).toBe(false);
  });

  it("offers a retry when the detail could not be loaded", () => {
    series.state.isError = true;
    draw(metric("collab.messages_sent", ["source_summary"], 6));
    expect(
      screen.getByRole("button", { name: /try again/i })
    ).toBeInTheDocument();
  });

  it("describes the strip for anyone not reading it with their eyes", () => {
    series.state.data = [reading("2026-03-01", 4), reading("2026-03-03", 9)];
    draw(metric("collab.messages_sent", ["source_summary"], 13));
    const label = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(label).toMatch(/Chat Messages Sent by day/);
    expect(label).toMatch(/busiest/);
    expect(label).toMatch(/3 days have no reading/);
  });

  it("anchors the day readout to the edge of the day it describes", () => {
    series.state.data = [reading("2026-03-01", 4), reading("2026-03-05", 9)];
    const { container } = draw(
      metric("collab.messages_sent", ["source_summary"], 13)
    );
    const bars = container.querySelectorAll<HTMLElement>('[role="img"] > div');
    expect(bars).toHaveLength(5);
    const readout = () =>
      container.querySelector<HTMLElement>('[role="img"] > [aria-hidden]')!;

    fireEvent.pointerEnter(bars[0]!);
    expect(readout().style.left).toBe("0%");
    expect(readout().style.transform).toBe("");

    fireEvent.pointerEnter(bars[4]!);
    expect(readout().style.left).toBe("100%");
    expect(readout().style.transform).toBe("translateX(-100%)");
  });

  it("says nothing was recorded rather than drawing an empty chart", () => {
    series.state.data = [];
    draw(metric("collab.messages_sent", ["source_summary"], 0));
    expect(
      screen.getByText(/Nothing recorded in this period/)
    ).toBeInTheDocument();
  });

  it("says no data yet rather than claiming the period was quiet", () => {
    series.state.data = [];
    series.notReady = true;
    draw(metric("collab.messages_sent", ["source_summary"], 0));
    expect(screen.getByText(/No data yet/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing recorded in this period/)
    ).not.toBeInTheDocument();
  });
});
