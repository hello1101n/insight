import { ensureOk, readJson } from "@/api/custom-client";
import { fetchWithAuth } from "@/api/fetch-with-auth";
import type { VisitorNaming } from "@/lib/portal/visitor-label";

const BASE = "/api/authenticator/v1";

export interface SqlTokenEntry {
  token_id: string;
  label: string;
  created_at: string;
  expires_at: string;
  person: VisitorNaming;
  created_by: VisitorNaming;
}

export interface SqlTokenList {
  items: SqlTokenEntry[];
}

export interface SqlTokenRequest {
  person_id: string;
  label: string;
  lifetime_days: number;
}

export interface CreatedSqlToken {
  token_id: string;
  token: string;
  person_id: string;
  label: string;
  created_at: string;
  expires_at: string;
}

export async function listSqlTokens(): Promise<SqlTokenList> {
  return readJson<SqlTokenList>(await fetchWithAuth(`${BASE}/sql-tokens`));
}

export async function createSqlToken(body: SqlTokenRequest): Promise<CreatedSqlToken> {
  const res = await fetchWithAuth(`${BASE}/sql-tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJson<CreatedSqlToken>(res);
}

export async function removeSqlToken(tokenId: string): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/sql-tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  });
  await ensureOk(res);
}
