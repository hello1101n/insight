import type { DisplayText } from "@/i18n/localized-text";
import { headlineMetricKeys } from "@/lib/insight/groups";
import { sectionMetricKeys, type LensConfig } from "@/lib/portal/lens-configs";
import { defaultZoneItem } from "@/lib/portal/nav-model";

const ATTENTION_KEYS: readonly string[] = headlineMetricKeys();

export const DEFAULT_OVERVIEW_ITEM = defaultZoneItem("overview")!;

export const OVERVIEW_ITEMS: Record<string, LensConfig> = {
  [DEFAULT_OVERVIEW_ITEM]: {
    title: { key: "overview.title" },
    tagline: { key: "overview.tagline_rollup" },
    sections: [
      {
        kind: "headline",
        metrics: [
          "git.default_branch_prs_merged",
          "git.pr_size",
          "tasks.closed",
          "collab.messages_sent",
          "ai.cost",
          "ai.daily_approximate_extra_usage_cost",
        ],
      },
      { kind: "attention", metrics: ATTENTION_KEYS, max: 8 },
      { kind: "direction-cards", variant: "compact" },
    ],
  },
  "by-direction": {
    title: { key: "overview.by_direction_title" },
    tagline: { key: "overview.tagline_next" },
    sections: [{ kind: "direction-cards", variant: "full" }],
  },
  attention: {
    title: { key: "worth_a_look.overview_title" },
    tagline: { key: "overview.tagline_who" },
    sections: [{ kind: "attention", metrics: ATTENTION_KEYS, max: 30 }],
  },
};

export type OwnOverviewItem =
  | { kind: "home" }
  | { kind: "lens"; config: LensConfig }
  | { kind: "attention"; title: DisplayText; tagline: DisplayText };

export const OWN_OVERVIEW_ITEMS: Record<string, OwnOverviewItem> = {
  [DEFAULT_OVERVIEW_ITEM]: { kind: "home" },
  "by-direction": {
    kind: "lens",
    config: {
      title: { key: "overview.by_direction" },
      tagline: { key: "overview.tagline_own_direction" },
      sections: [{ kind: "direction-cards", variant: "full" }],
    },
  },
  attention: {
    kind: "attention",
    title: { key: "worth_a_look.title" },
    tagline: { key: "overview.tagline_own_attention" },
  },
};

export function overviewMetricKeys(): string[] {
  const keys = new Set<string>();
  for (const config of Object.values(OVERVIEW_ITEMS)) {
    for (const k of sectionMetricKeys(config)) keys.add(k);
  }
  return [...keys];
}
