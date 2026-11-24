import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/fetch-with-auth", () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from "@/api/fetch-with-auth";

import { createApiToken, listApiTokens, removeApiToken } from "./api-tokens-client";

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

describe("listApiTokens", () => {
  it("reads the stand's tokens", async () => {
    const listed = {
      items: [
        {
          token_id: "t-1",
          label: "laptop",
          created_at: "2026-11-12T10:00:00Z",
          expires_at: "2027-11-12T10:00:00Z",
          person: PERSON,
          created_by: ADMIN,
        },
      ],
    };
    mockFetch.mockResolvedValueOnce(response(listed));

    await expect(listApiTokens()).resolves.toEqual(listed);
    expect(mockFetch).toHaveBeenCalledWith("/api/authenticator/v1/api-tokens");
  });

  it("raises a refusal with its status", async () => {
    mockFetch.mockResolvedValueOnce(response({ detail: "admin role required" }, { ok: false, status: 403 }));

    await expect(listApiTokens()).rejects.toMatchObject({ status: 403 });
  });
});

describe("createApiToken", () => {
  it("posts the person, label and lifetime and hands back the token once", async () => {
    const created = {
      token_id: "t-2",
      token: "iapi_synthetic-token-for-tests",
      person_id: PERSON.person_id,
      label: "ci",
      created_at: "2026-11-12T10:00:00Z",
      expires_at: "2027-11-12T10:00:00Z",
    };
    mockFetch.mockResolvedValueOnce(response(created, { status: 201 }));

    await expect(
      createApiToken({ person_id: PERSON.person_id, label: "ci", lifetime_days: 365 }),
    ).resolves.toEqual(created);
    expect(mockFetch).toHaveBeenCalledWith("/api/authenticator/v1/api-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ person_id: PERSON.person_id, label: "ci", lifetime_days: 365 }),
    });
  });

});

describe("removeApiToken", () => {
  it("deletes the token by id", async () => {
    mockFetch.mockResolvedValueOnce(response(null, { status: 204 }));

    await removeApiToken("t-1");

    expect(mockFetch).toHaveBeenCalledWith("/api/authenticator/v1/api-tokens/t-1", { method: "DELETE" });
  });

});
