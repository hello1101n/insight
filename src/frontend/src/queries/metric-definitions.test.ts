import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as client from "@/api/metric-definitions-client";
import type {
  MetricDefinition,
  MetricDefinitionListResponse,
} from "@/api/metric-definitions-client";
import type { MetricEvidenceSelection } from "@/api/metric-drilldown-client";
import {
  groupByKeyPrefix,
  useMetricDefinitions,
  useTypedEvidenceSelection,
} from "@/queries/metric-definitions";

vi.mock("@/api/metric-definitions-client", async (orig) => ({
  ...(await orig<typeof import("@/api/metric-definitions-client")>()),
  listMetricDefinitions: vi.fn(),
}));

const mockList = vi.mocked(client.listMetricDefinitions);

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

function metric(metric_key: string): MetricDefinition {
  return {
    metric_key,
    entity_type: "person",
    label: metric_key,
    short_label: null,
    description: null,
    explanation: null,
    unit: null,
    format: "integer",
    direction: "neutral",
    dimensions: [],
    is_enabled: true,
    origin: "builtin" as const,
    schema_status: "ok",
    schema_error_code: null,
    first_observed_date: null,
    last_observed_date: null,
  };
}

describe("groupByKeyPrefix", () => {
  it("groups by the metric_key prefix preserving server order", () => {
    const groups = groupByKeyPrefix([
      metric("ai.cost"),
      metric("ai.active_days"),
      metric("git.commits"),
      metric("tasks.completed"),
    ]);
    expect(groups.map((g) => g.prefix)).toEqual(["ai", "git", "tasks"]);
    expect(groups[0]?.metrics.map((m) => m.metric_key)).toEqual([
      "ai.cost",
      "ai.active_days",
    ]);
  });

  it("uses the whole key when there is no dot", () => {
    const groups = groupByKeyPrefix([metric("standalone")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.prefix).toBe("standalone");
  });

  it("returns no groups for an empty catalog", () => {
    expect(groupByKeyPrefix([])).toEqual([]);
  });
});

describe("useMetricDefinitions", () => {
  beforeEach(() => {
    mockList.mockReset();
  });

  it("fetches the catalog and exposes it grouped by prefix", async () => {
    mockList.mockResolvedValue({
      metrics: [metric("git.commits"), metric("ai.cost")],
    });
    const { result } = renderHook(() => useMetricDefinitions(), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(result.current.data?.map((g) => g.prefix)).toEqual(["git", "ai"]);
  });
});

describe("useTypedEvidenceSelection", () => {
  const TASKS: MetricEvidenceSelection = {
    metric_key: "tasks.closed",
    entity: { type: "person", id: "person-1" },
    period: { from: "2026-03-01", to: "2026-03-31" },
    filters: [],
    display_dimensions: [],
  };

  beforeEach(() => {
    mockList.mockReset();
  });

  it("asks for no evidence until the catalogue says which dimensions exist", async () => {
    let answer: (response: MetricDefinitionListResponse) => void = () => {};
    mockList.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    const { result } = renderHook(() => useTypedEvidenceSelection(TASKS), {
      wrapper: wrapper(),
    });

    expect(result.current).toBeNull();

    answer({ metrics: [{ ...metric("tasks.closed"), dimensions: ["type"] }] });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.display_dimensions).toEqual(["type"]);
  });
});
