import { afterEach, describe, expect, it, vi } from "vitest";

import { CustomApiError } from "@/api/custom-client";

vi.mock("@/api/fetch-with-auth", () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from "@/api/fetch-with-auth";
import {
  fetchPersonalMetrics,
  fetchPersonalRecords,
  fetchPersonalValues,
} from "./personal-metrics-client";

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => vi.mocked(fetchWithAuth).mockReset());

describe("personal metrics client", () => {
  it("fetchPersonalMetrics returns the metrics list", async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(reply(200, { metrics: [{ id: "a" }] }));
    expect(await fetchPersonalMetrics()).toEqual([{ id: "a" }]);
    expect(vi.mocked(fetchWithAuth).mock.calls[0]![0]).toMatch(/\/personal-metrics$/);
  });

  it("fetchPersonalValues posts the request body", async () => {
    const body = { values: [], teams: [] };
    vi.mocked(fetchWithAuth).mockResolvedValue(reply(200, body));
    const request = { metrics: ["a"], person_ids: ["p"], from: "2026-01-01", to: "2026-02-01" };
    expect(await fetchPersonalValues(request)).toEqual(body);
    const [url, init] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    expect(url).toMatch(/\/personal-metrics\/values$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual(request);
  });

  it("fetchPersonalRecords posts to the metric's records path", async () => {
    const page = { columns: [], rows: [], next_cursor: null };
    vi.mocked(fetchWithAuth).mockResolvedValue(reply(200, page));
    const request = { person_id: "p", from: "2026-01-01", to: "2026-02-01" };
    expect(await fetchPersonalRecords("a b", request)).toEqual(page);
    expect(vi.mocked(fetchWithAuth).mock.calls[0]![0]).toMatch(
      /\/personal-metrics\/a%20b\/records$/,
    );
  });

  it("throws CustomApiError on a non-2xx reply", async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(reply(429, { detail: "busy" }));
    const failure = await fetchPersonalMetrics().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CustomApiError);
    expect((failure as CustomApiError).status).toBe(429);
  });
});
