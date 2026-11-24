import { ensureOk, readJson } from "@/api/custom-client";
import { fetchWithAuth } from "@/api/fetch-with-auth";
import type { VisitorNaming } from "@/lib/portal/visitor-label";

const BASE = "/api/authenticator/v1";

export interface ApiTokenEntry {
  token_id: string;
  label: string;
  created_at: string;
  expires_at: string;
  person: VisitorNaming;
  created_by: VisitorNaming;
}

export interface ApiTokenList {
  items: ApiTokenEntry[];
}

export interface ApiTokenRequest {
  person_id: string;
  label: string;
  lifetime_days: number;
}

export interface CreatedApiToken {
  token_id: string;
  token: string;
  person_id: string;
  label: string;
  created_at: string;
  expires_at: string;
}

export async function listApiTokens(): Promise<ApiTokenList> {
  return readJson<ApiTokenList>(await fetchWithAuth(`${BASE}/api-tokens`));
}

export async function createApiToken(body: ApiTokenRequest): Promise<CreatedApiToken> {
  const res = await fetchWithAuth(`${BASE}/api-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<CreatedApiToken>(res);
}

export async function removeApiToken(tokenId: string): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/api-tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  });
  await ensureOk(res);
}
