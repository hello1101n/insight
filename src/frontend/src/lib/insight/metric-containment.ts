import { isRankable } from "@/lib/scoring";
import type { PeerStatusWithNeutral } from "@/lib/peers";

export const METRIC_CONTAINS: Readonly<Record<string, readonly string[]>> = {
  "git.lines_added": ["git.code_lines"],
  "git.default_branch_lines_added": ["git.default_branch_code_lines"],
  "git.commits": ["git.default_branch_commits"],
  "git.prs_merged": ["git.default_branch_prs_merged"],
  "collab.files_shared": [
    "collab.files_shared_internal",
    "collab.files_shared_external",
  ],
  "collab.messages_sent": ["collab.channel_posts"],
};

export const METRIC_RESTATES: readonly (readonly string[])[] = [
  ["collab.focus_time_pct", "collab.meeting_hours", "collab.meeting_free_days"],
];

const RESTATEMENT_GROUP = new Map<string, number>(
  METRIC_RESTATES.flatMap((group, index) =>
    group.map((key) => [key, index] as const)
  )
);

export function countableSignals<T>(
  entries: readonly T[],
  keyOf: (entry: T) => string,
  rankOf: (entry: T) => PeerStatusWithNeutral | null
): T[] {
  const ranked = entries.filter((entry) => isRankable(rankOf(entry)));
  const kept = dropRedundantMetrics(
    ranked.map((entry) => ({ key: keyOf(entry), entry }))
  );
  return kept.map((item) => item.entry);
}

export function dropRedundantMetrics<T extends { key: string }>(
  items: readonly T[],
  alreadyShown: ReadonlySet<string> = new Set()
): T[] {
  const present = new Set(items.map((item) => item.key));
  const shownGroups = new Set(
    [...alreadyShown].flatMap((key) => {
      const group = RESTATEMENT_GROUP.get(key);
      return group == null ? [] : [group];
    })
  );
  const kept: T[] = [];
  for (const item of items) {
    const containsShown = [...(METRIC_CONTAINS[item.key] ?? [])].some(
      (narrower) => present.has(narrower) || alreadyShown.has(narrower)
    );
    if (containsShown) continue;
    const group = RESTATEMENT_GROUP.get(item.key);
    if (group != null) {
      if (shownGroups.has(group)) continue;
      shownGroups.add(group);
    }
    kept.push(item);
  }
  return kept;
}
