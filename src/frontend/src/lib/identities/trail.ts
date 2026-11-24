import type {
  AccountOperation,
  BindingHistoryEntry,
} from "@/api/identity-client";

export interface TrailEvent {
  key: string;
  entry: BindingHistoryEntry;
  comment?: string;
}

export function accountTrail(
  history: BindingHistoryEntry[],
  operations: AccountOperation[] | undefined,
): TrailEvent[] {
  const moved = movements(history);
  const comments = attribute(moved, operations ?? []);
  return moved
    .map((entry, index) => {
      const comment = comments.get(entry);
      return {
        key: `${entry.recorded_at}-${index}`,
        entry,
        ...(comment ? { comment } : {}),
      };
    })
    .reverse();
}

function movements(history: BindingHistoryEntry[]): BindingHistoryEntry[] {
  const oldestFirst = [...history].reverse();
  const kept: BindingHistoryEntry[] = [];
  let held: string | undefined;
  for (const entry of oldestFirst) {
    if (entry.by_operator || entry.person_id !== held) kept.push(entry);
    held = entry.person_id;
  }
  return kept;
}

function attribute(
  moved: BindingHistoryEntry[],
  operations: AccountOperation[],
): Map<BindingHistoryEntry, string> {
  const named = new Map<BindingHistoryEntry, string>();
  const decisions = groupBy(
    moved.filter((entry) => entry.by_operator),
    (entry) => group(entry.author_person_id, entry.reason),
  );
  const calls = groupBy(operations, (op) => group(op.author_person_id, op.verb));

  for (const [at, rows] of decisions) {
    const made = calls.get(at);
    if (!made || made.length !== rows.length) continue;
    const ordered = [...made].sort((a, b) =>
      a.recorded_at.localeCompare(b.recorded_at),
    );
    rows.forEach((entry, index) => {
      const comment = ordered[index]?.comment?.trim();
      if (comment) named.set(entry, comment);
    });
  }
  return named;
}

function group(author: string, verb: string | null | undefined): string {
  return `${author} ${verb?.trim() ?? ""}`;
}

function groupBy<T>(items: T[], of: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const at = of(item);
    const existing = groups.get(at);
    if (existing) existing.push(item);
    else groups.set(at, [item]);
  }
  return groups;
}
