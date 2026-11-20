import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/fetch-with-auth", () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from "@/api/fetch-with-auth";

import { AnalyticsApiError } from "./analytics-client";
import { createSqlToken, listSqlTokens, removeSqlToken } from "./sql-tokens-client";

const mockFetch = fetchWithAuth as unknown as ReturnType<typeof vi.fn>;

function response(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

const PERSON = {
  person_id: "00000000-0000-4000-8000-000000000001",
  display_name: "Example Holder",
  username: "holder",
  email: "holder@example.com",
};

const ADMIN = {
  person_id: "00000000-0000-4000-8000-000000000002",
  display_name: "Example Admin",
  username: "admin",
  email: "admin@example.com",
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe("listSqlTokens", () => {
  it("reads the stand's tokens", async () => {
    const listed = {
      items: [
        {
          token_id: "t-1",
          label: "laptop",
          created_at: "2026-11-12T10:00:00Z",
          person: PERSON,
          created_by: ADMIN,
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(response(listed));

    await expect(listSqlTokens()).resolves.toEqual(listed);
    expect(mockFetch).toHaveBeenCalledWith("/api/analytics/v1/sql-tokens");
  });

  it("raises a refusal with its status", async () => {
    mockFetch.mockResolvedValueOnce(response({ detail: "admin role required" }, { ok: false, status: 403 }));

    await expect(listSqlTokens()).rejects.toMatchObject({ status: 403 });
  });
});

describe("createSqlToken", () => {
  it("posts the person and label and hands back the token once", async () => {
    const created = {
      token_id: "t-2",
      token: "isql_synthetic-token-for-tests",
      person_id: PERSON.person_id,
      label: "ci",
      created_at: "2026-11-12T10:00:00Z",
    };
    mockFetch.mockResolvedValueOnce(response(created, { status: 201 }));

    await expect(createSqlToken({ person_id: PERSON.person_id, label: "ci" })).resolves.toEqual(created);
    expect(mockFetch).toHaveBeenCalledWith("/api/analytics/v1/sql-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: PERSON.person_id, label: "ci" }),
    });
  });

  it("raises a refused label as an API error", async () => {
    mockFetch.mockResolvedValueOnce(response({ detail: "label must not be empty" }, { ok: false, status: 400 }));

    await expect(createSqlToken({ person_id: PERSON.person_id, label: " " })).rejects.toBeInstanceOf(
      AnalyticsApiError,
    );
  });
});

describe("removeSqlToken", () => {
  it("deletes the token by id", async () => {
    mockFetch.mockResolvedValueOnce(response(null, { status: 204 }));

    await removeSqlToken("t-1");

    expect(mockFetch).toHaveBeenCalledWith("/api/analytics/v1/sql-tokens/t-1", { method: "DELETE" });
  });

  it("raises when the token is not there", async () => {
    mockFetch.mockResolvedValueOnce(response(null, { ok: false, status: 404 }));

    await expect(removeSqlToken("gone")).rejects.toMatchObject({ status: 404 });
  });
});
