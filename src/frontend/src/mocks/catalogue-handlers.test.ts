import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { catalogueHandlers } from "./catalogue-handlers";

const server = setupServer(...catalogueHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const read = async <T>(path: string, method = "GET"): Promise<T> => {
  const response = await fetch(
    new URL(`/api/v3/v1${path}`, window.location.href),
    { method }
  );
  expect(response.status, `${method} ${path}`).toBe(200);
  return (await response.json()) as T;
};

describe("catalogue mocks", () => {
  it.each([
    ["deploy", 2],
    ["duration", 1],
  ])("count every match of %s, not only the page", async (needle, total) => {
    const page = await read<{ items: { id: string }[]; total: number }>(
      `/metrics?q=${needle}&limit=1`
    );

    expect(page.items).toHaveLength(1);
    expect(page.total, `matches of ${needle}`).toBe(total);
  });

  it.each([
    ["asc", [120, 149, 167]],
    ["desc", [402, 355, 308]],
  ])("order the records by a numeric field, %s", async (direction, first) => {
    const page = await read<{ records: { raw_data: { duration_s: number } }[] }>(
      `/datasets/deployments/records?order_by=duration_s&direction=${direction}&limit=3`
    );

    expect(page.records.map((record) => record.raw_data.duration_s)).toEqual(
      first
    );
  });

  it("name the widget that draws a metric, and the metric a widget draws", async () => {
    const holders = await read<{ holders: { id: string }[] }>(
      "/metrics/deploys/dependents"
    );
    const widgets = await read<{ items: { metric_name: string | null }[] }>(
      "/widgets"
    );

    expect(holders.holders.map((holder) => holder.id)).toEqual([
      "deploys-per-week",
    ]);
    expect(widgets.items.every((widget) => widget.metric_name)).toBe(true);
  });
});
