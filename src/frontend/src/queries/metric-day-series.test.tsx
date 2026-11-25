import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SingleEntityEvidenceSelection } from "@/api/metric-drilldown-client";
import * as client from "@/api/metric-results-client";

vi.mock("@/api/metric-results-client");

const session = vi.hoisted(() => ({ value: { scope: "tenant-a" } as unknown }));
vi.mock("@/auth/use-auth", () => ({
  useAuth: () => ({ session: session.value }),
}));
vi.mock("@/auth/session-scope", () => ({
  sessionAuthorizationScope: (s: unknown) =>
    s == null ? null : (s as { scope: string }).scope,
}));

import { useMetricDaySeries } from "./metric-day-series";

const ME = "019e27bc-dec0-7626-81a9-c5524662a6a9";

const SELECTION: SingleEntityEvidenceSelection = {
  metric_key: "git.code_lines",
  entity: { type: "person", id: ME },
  period: { from: "2026-03-01", to: "2026-03-05" },
  filters: [],
  display_dimensions: [],
};

type Point = {
  bucket_start: string;
  value: number | null;
  numerator?: number | null;
  denominator?: number | null;
};

function answers(points: Point[], metricKey = SELECTION.metric_key) {
  vi.mocked(client.queryMetricResults).mockResolvedValue({
    metrics: [
      {
        metric_key: metricKey,
        views: [{ view: "timeseries", bucket: "day", series: [{ points }] }],
      },
    ],
  } as unknown as client.MetricResultsResponse);
}

function harness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper };
}

async function series(selection: SingleEntityEvidenceSelection = SELECTION) {
  const { wrapper } = harness();
  const { result } = renderHook(() => useMetricDaySeries(selection), {
    wrapper,
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data;
}

async function readings(selection: SingleEntityEvidenceSelection = SELECTION) {
  return (await series(selection))?.readings;
}

beforeEach(() => {
  vi.clearAllMocks();
  session.value = { scope: "tenant-a" };
});

describe("useMetricDaySeries", () => {
  it("keeps a day that measured zero and drops one with no reading at all", async () => {
    answers([
      { bucket_start: "2026-03-01", value: 4 },
      { bucket_start: "2026-03-02", value: 0 },
      { bucket_start: "2026-03-03", value: null },
    ]);
    expect(await readings()).toEqual([
      { date: "2026-03-01", value: 4, numerator: null, denominator: null },
      { date: "2026-03-02", value: 0, numerator: null, denominator: null },
    ]);
  });

  it("takes a ratio's value as the metric computed it, sides and all", async () => {
    answers([
      { bucket_start: "2026-03-01", value: 50, numerator: 7, denominator: 8 },
      { bucket_start: "2026-03-02", value: 25, numerator: 1, denominator: 4 },
    ]);
    expect(await readings()).toEqual([
      { date: "2026-03-01", value: 50, numerator: 7, denominator: 8 },
      { date: "2026-03-02", value: 25, numerator: 1, denominator: 4 },
    ]);
  });

  it("names both sides of a ratio even on a day with no numerator", async () => {
    answers([
      { bucket_start: "2026-03-01", value: null, numerator: null, denominator: 8 },
    ]);
    expect(await readings()).toEqual([
      { date: "2026-03-01", value: 0, numerator: 0, denominator: 8 },
    ]);
  });

  it("refuses a view whose computation failed rather than reading it as an empty period", async () => {
    vi.mocked(client.queryMetricResults).mockResolvedValue({
      metrics: [
        {
          metric_key: SELECTION.metric_key,
          views: [
            { view: "error", code: "QUERY_FAILED", message: "broken" },
          ],
        },
      ],
    } as unknown as client.MetricResultsResponse);
    const { wrapper } = harness();
    const { result } = renderHook(() => useMetricDaySeries(SELECTION), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("keeps a day whose denominator is zero, so the strip can still name it", async () => {
    answers([
      { bucket_start: "2026-03-01", value: null, numerator: null, denominator: 0 },
    ]);
    expect(await readings()).toEqual([
      { date: "2026-03-01", value: 0, numerator: 0, denominator: 0 },
    ]);
  });

  it("orders days oldest first whatever order the wire used", async () => {
    answers([
      { bucket_start: "2026-03-03", value: 3 },
      { bucket_start: "2026-03-01", value: 1 },
    ]);
    expect((await readings())?.map((d) => d.date)).toEqual([
      "2026-03-01",
      "2026-03-03",
    ]);
  });

  it("asks for the metric's own days, over the selection's own window", async () => {
    answers([]);
    await readings();
    expect(vi.mocked(client.queryMetricResults)).toHaveBeenCalledWith(
      {
        entity: { type: "person", ids: [ME] },
        period: { from: "2026-03-01", to: "2026-03-05" },
        metrics: [
          {
            metric_key: "git.code_lines",
            filters: [],
            views: [{ view: "timeseries", bucket: "day" }],
          },
        ],
      },
      expect.anything()
    );
  });

  it("carries the selection's filters, so the days match the number above them", async () => {
    const filters = [{ dimension: "repository", values: ["acme/api"] }];
    answers([]);
    await readings({ ...SELECTION, filters });
    const body = vi.mocked(client.queryMetricResults).mock.calls[0]?.[0];
    expect(body?.metrics[0]?.filters).toEqual(filters);
  });

  it("answers with nothing when the response carries no timeseries", async () => {
    vi.mocked(client.queryMetricResults).mockResolvedValue({
      metrics: [{ metric_key: SELECTION.metric_key, views: [] }],
    } as unknown as client.MetricResultsResponse);
    expect(await readings()).toEqual([]);
  });

  it("answers a not-ready view as no data yet, not as a failure or an empty period", async () => {
    vi.mocked(client.queryMetricResults).mockResolvedValue({
      metrics: [
        {
          metric_key: SELECTION.metric_key,
          views: [{ view: "not_ready", reason: "SOURCE_RELATION_MISSING" }],
        },
      ],
    } as unknown as client.MetricResultsResponse);

    expect(await series()).toEqual({ readings: [], notReady: true });
  });

  it("marks a read over built data as ready, so a quiet period stays a quiet period", async () => {
    answers([]);
    expect(await series()).toEqual({ readings: [], notReady: false });
  });

  it("does not read without a session", async () => {
    session.value = null;
    answers([{ bucket_start: "2026-03-01", value: 4 }]);
    const { wrapper } = harness();
    const { result } = renderHook(() => useMetricDaySeries(SELECTION), {
      wrapper,
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(vi.mocked(client.queryMetricResults)).not.toHaveBeenCalled();
  });

  it("does not read without a selection", async () => {
    answers([]);
    const { wrapper } = harness();
    const { result } = renderHook(() => useMetricDaySeries(null), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(vi.mocked(client.queryMetricResults)).not.toHaveBeenCalled();
  });
});
