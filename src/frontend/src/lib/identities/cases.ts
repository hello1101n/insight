import type { AttentionItem, PersonSummary } from "@/api/identity-client";
import { accountKey, itemKey } from "@/lib/identities/account-key";

export interface QueueCase {
  key: string;
  candidates: PersonSummary[];
  items: AttentionItem[];
}

export const KIND_SEARCH_MATCH = "match";

export function isQueueItem(kind: string): boolean {
  return kind !== KIND_SEARCH_MATCH;
}

const CONFIRMABLE_KINDS: ReadonlySet<string> = new Set([
  "provisioned_at_login",
  "minted_from_roster",
]);

export function groupIsConfirmable(
  kind: string,
  items: AttentionItem[],
): boolean {
  return (
    CONFIRMABLE_KINDS.has(kind) &&
    items.length > 0 &&
    items.every((item) => Boolean(item.bound_to))
  );
}

function caseKey(item: AttentionItem): string {
  if (item.candidates.length === 0) return `account:${itemKey(item)}`;
  const ids = item.candidates.map((c) => c.person_id).sort();
  return `people:${ids.join("|")}`;
}

export function dropDecided(
  items: AttentionItem[],
  outcomes: ReadonlyArray<{
    source: string;
    source_id: string;
    account_id: string;
    outcome: string;
  }>,
): AttentionItem[] {
  const decided = new Set(
    outcomes
      .filter((o) => o.outcome === "applied" || o.outcome === "already_decided")
      .map(accountKey),
  );
  if (decided.size === 0) return items;
  return items.filter((item) => !decided.has(accountKey(item)));
}

export function groupIntoCases(items: AttentionItem[]): QueueCase[] {
  const byKey = new Map<string, QueueCase>();
  for (const item of items) {
    const key = caseKey(item);
    const existing = byKey.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    byKey.set(key, { key, candidates: item.candidates, items: [item] });
  }
  return [...byKey.values()];
}
