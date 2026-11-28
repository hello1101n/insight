import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  queryMetricResults,
  type MetricResultsRequest,
  type MetricResultsResponse,
} from "@/api/metric-results-client";
import {
  fetchPersonalValues,
  type PersonalMetric,
  type PersonalValuesRequest,
} from "@/api/personal-metrics-client";
import { personalDefinition } from "@/lib/portal/personal-metrics";
import { useMetricsViewData } from "@/queries/metrics-view";

vi.mock("@/api/metric-results-client", async (orig) => ({
  ...(await orig<typeof import("@/api/metric-results-client")>()),
  queryMetricResults: vi.fn(),
}));
vi.mock("@/api/personal-metrics-client", () => ({
  fetchPersonalValues: vi.fn(),
}));

const mock = vi.mocked(queryMetricResults);
const personalMock = vi.mocked(fetchPersonalValues);

function personalMetric(id: string, over: Partial<PersonalMetric> = {}): PersonalMetric {
  return {
    id,
    label: `Label ${id}`,
    unit: null,
    format: "number",
    direction: "neutral",
    description: null,
    calculation: "sum",
    shared_by: null,
    ...over,
  };
}

function respondPersonal(req: PersonalValuesRequest) {
  return {
    values: req.metrics.flatMap((metric) =>
      req.person_ids.map((person_id) => ({ metric, person_id, value: 7 })),
    ),
    teams: [],
    errors: [],
  };
}

function respond(req: MetricResultsRequest): MetricResultsResponse {
  if (req.entity.type !== "person") throw new Error("person request expected");
  const ids = req.entity.ids;

  return {
    metrics: req.metrics.map((m) => ({
      metric_key: m.metric_key,
      label: m.metric_key,
      unit: null,
      format: "integer",
      direction: "higher_is_better",
      computation: "sum",
      views: [
        {
          view: "period",
          values: ids.map((id) => ({ entity_id: id, value: 1 })),
        },
      ],
    })),
  };
}

const RANGE = { from: "2026-04-01", to: "2026-04-30" };
const KEYS = Array.from({ length: 120 }, (_, i) => `git.m${i}`);

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

describe("useMetricsViewData", () => {
  beforeEach(() => {
    mock.mockReset();
    mock.mockImplementation(async (req) => respond(req));
    personalMock.mockReset();
    personalMock.mockImplementation(async (req) => respondPersonal(req));
  });

  it("personal keys go to insight-v3", async () => {
    const focus = personalDefinition(personalMetric("focus"));
    const { result } = renderHook(
      () =>
        useMetricsViewData(
          ["git.commits", focus.metric_key],
          ["b@x.com", "a@x.com"],
          RANGE,
          [focus],
        ),
      { wrapper: wrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
      expect(result.current.byKey.get("personal.focus")?.period).toBeDefined();
    });

    expect(mock.mock.calls.flatMap(([req]) => req.metrics.map((m) => m.metric_key))).toEqual([
      "git.commits",
    ]);
    expect(personalMock).toHaveBeenCalledTimes(1);
    expect(personalMock).toHaveBeenCalledWith({
      metrics: ["focus"],
      person_ids: ["a@x.com", "b@x.com"],
      from: "2026-04-01",
      to: "2026-05-01",
    });
    expect(result.current.byKey.get("personal.focus")?.period?.values).toEqual([
      { entity_id: "a@x.com", value: 7 },
      { entity_id: "b@x.com", value: 7 },
    ]);
    expect(result.current.byKey.get("git.commits")?.period?.values).toHaveLength(2);
  });

  it("takes a personal column's label, unit, format, direction and description from its definition", async () => {
    const focus = personalDefinition(
      personalMetric("focus", {
        label: "Focus hours",
        unit: "h",
        format: "percent",
        direction: "lower_is_better",
        description: "Hours without meetings",
      }),
    );
    const { result } = renderHook(
      () => useMetricsViewData([focus.metric_key], ["a@x.com"], RANGE, [focus]),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.byKey.get("personal.focus")?.period).toBeDefined());

    expect(result.current.byKey.get("personal.focus")).toMatchObject({
      metric_key: "personal.focus",
      label: "Focus hours",
      unit: "h",
      format: "percent",
      direction: "lower_is_better",
      description: "Hours without meetings",
    });
  });

  it("asks insight-v3 for at most 1,000 people and 50 metrics a request", async () => {
    const definitions = Array.from({ length: 60 }, (_, i) =>
      personalDefinition(personalMetric(`m${i}`)),
    );
    const people = Array.from({ length: 1500 }, (_, i) => `p${String(i).padStart(4, "0")}@x.com`);
    const { result } = renderHook(
      () =>
        useMetricsViewData(
          definitions.map((definition) => definition.metric_key),
          people,
          RANGE,
          definitions,
        ),
      { wrapper: wrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
      expect(result.current.byKey.get("personal.m59")?.period?.values).toHaveLength(1500);
    });

    const shapes = personalMock.mock.calls
      .map(([req]) => [req.metrics.length, req.person_ids.length])
      .sort(([a, b], [c, d]) => d! - b! || c! - a!);
    expect(shapes).toEqual([
      [50, 1000],
      [10, 1000],
      [50, 500],
      [10, 500],
    ]);
    expect(mock).not.toHaveBeenCalled();
  });

  it("a personal failure keeps built-in values", async () => {
    personalMock.mockRejectedValue(new Error("insight-v3 is down"));
    const focus = personalDefinition(personalMetric("focus"));
    const { result } = renderHook(
      () => useMetricsViewData(["git.commits", focus.metric_key], ["a@x.com"], RANGE, [focus]),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.personalFailed).toEqual(new Set(["personal.focus"])));

    expect(result.current.isError).toBe(false);
    expect(result.current.isPending).toBe(false);
    expect(result.current.byKey.get("git.commits")?.period?.values).toEqual([
      { entity_id: "a@x.com", value: 1 },
    ]);
    expect(result.current.byKey.get("personal.focus")?.period).toBeUndefined();
  });

  it("does not ask insight-v3 when no personal metric is picked", async () => {
    const { result } = renderHook(
      () => useMetricsViewData(["git.commits"], ["a@x.com"], RANGE),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.byKey.has("git.commits")).toBe(true));

    expect(personalMock).not.toHaveBeenCalled();
    expect(result.current.personalFailed.size).toBe(0);
    expect(result.current.personalPending.size).toBe(0);
  });

  it("shows built-in values while personal values are still loading", async () => {
    personalMock.mockImplementation(() => new Promise(() => {}));
    const focus = personalDefinition(personalMetric("focus"));
    const { result } = renderHook(
      () => useMetricsViewData(["git.commits", focus.metric_key], ["a@x.com"], RANGE, [focus]),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.byKey.get("git.commits")?.period).toBeDefined());

    expect(result.current.isPending).toBe(false);
    expect(result.current.personalPending).toEqual(new Set(["personal.focus"]));
    expect(result.current.personalFailed.size).toBe(0);
  });

  it("stays drawn when the personal catalog arrives after the built-in values", async () => {
    personalMock.mockImplementation(() => new Promise(() => {}));
    const focus = personalDefinition(personalMetric("focus"));
    const { result, rerender } = renderHook(
      ({ keys, personal }) => useMetricsViewData(keys, ["a@x.com"], RANGE, personal),
      {
        wrapper: wrapper(),
        initialProps: { keys: ["git.commits"], personal: [] as (typeof focus)[] },
      },
    );
    await waitFor(() => expect(result.current.byKey.get("git.commits")?.period).toBeDefined());

    rerender({ keys: ["git.commits", focus.metric_key], personal: [focus] });

    await waitFor(() => expect(personalMock).toHaveBeenCalled());
    expect(result.current.isPending).toBe(false);
    expect(result.current.personalPending).toEqual(new Set(["personal.focus"]));
  });

  it("marks as failed only the metrics insight-v3 lists in errors", async () => {
    personalMock.mockImplementation(async (req) => ({
      ...respondPersonal({ ...req, metrics: req.metrics.filter((metric) => metric !== "broken") }),
      errors: [{ metric: "broken" }],
    }));
    const focus = personalDefinition(personalMetric("focus"));
    const broken = personalDefinition(personalMetric("broken"));
    const { result } = renderHook(
      () =>
        useMetricsViewData(
          [focus.metric_key, broken.metric_key],
          ["a@x.com"],
          RANGE,
          [focus, broken],
        ),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.personalPending.size).toBe(0));

    expect(result.current.personalFailed).toEqual(new Set(["personal.broken"]));
    expect(result.current.byKey.get("personal.focus")?.period?.values).toEqual([
      { entity_id: "a@x.com", value: 7 },
    ]);
    expect(result.current.byKey.get("personal.broken")?.period?.values).toEqual([]);
  });

  it("asks for at most 50 metrics per request and serves all of them", async () => {
    const { result } = renderHook(
      () => useMetricsViewData(KEYS, ["a@x.com", "b@x.com"], RANGE),
      { wrapper: wrapper() },
    );

    await waitFor(() => {
      expect(result.current.isPending).toBe(false);
      expect(result.current.byKey.size).toBe(120);
    });

    const sizes = mock.mock.calls.map(([req]) => req.metrics.length);
    expect(sizes.sort((a, b) => b - a)).toEqual([50, 50, 20]);
  });

  it("asks for the period value only, with no comparison window", async () => {
    const { result } = renderHook(
      () => useMetricsViewData(["git.commits"], ["a@x.com"], RANGE),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.byKey.has("git.commits")).toBe(true));

    const req = mock.mock.calls[0]![0];
    expect(req.metrics[0]?.views.map((v) => v.view)).toEqual(["period"]);
    expect(req.compare_to).toBeUndefined();
  });

  it("asks for every metric as the server defines it, with no dimension filter", async () => {
    const { result } = renderHook(
      () =>
        useMetricsViewData(
          ["git.pr_comments", "git.pr_comments_on_others", "git.commits"],
          ["a@x.com"],
          RANGE,
        ),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.byKey.has("git.commits")).toBe(true));

    const metrics = mock.mock.calls[0]![0].metrics;
    expect(metrics.map((m) => m.filters)).toEqual([undefined, undefined, undefined]);
  });

  it("asks again for the new period when the period changes", async () => {
    const { result, rerender } = renderHook(
      ({ range }) => useMetricsViewData(["git.commits"], ["a@x.com"], range),
      { wrapper: wrapper(), initialProps: { range: RANGE } },
    );
    await waitFor(() => expect(result.current.byKey.has("git.commits")).toBe(true));

    rerender({ range: { from: "2026-04-24", to: "2026-04-30" } });

    await waitFor(() =>
      expect(mock.mock.calls.map(([req]) => req.period.from)).toEqual([
        "2026-04-01",
        "2026-04-24",
      ]),
    );
  });

  it("does not fetch when the scope has no people", () => {
    const { result } = renderHook(() => useMetricsViewData(KEYS, [], RANGE), {
      wrapper: wrapper(),
    });

    expect(result.current.byKey.size).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });
});
