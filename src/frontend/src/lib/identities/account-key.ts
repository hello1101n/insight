import type { AttentionItem } from "@/api/identity-client";

const SEPARATOR = ":";

export interface AccountRef {
  source: string;
  source_id: string;
  account_id: string;
}

export function accountKey(ref: AccountRef): string {
  return [ref.source, ref.source_id, ref.account_id]
    .map(encodeURIComponent)
    .join(SEPARATOR);
}

export function parseAccountKey(key: string | undefined): AccountRef | null {
  if (!key) return null;
  const parts = key.split(SEPARATOR);
  if (parts.length !== 3 || parts.some((p) => p === "")) return null;
  try {
    const [source, source_id, account_id] = parts.map(decodeURIComponent);
    return { source, source_id, account_id };
  } catch {
    return null;
  }
}

export function itemKey(item: AttentionItem): string {
  return accountKey(item);
}
