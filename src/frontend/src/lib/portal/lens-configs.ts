import type { DisplayText } from "@/i18n/localized-text";
import { evidenceCarriers } from "@/lib/metrics/evidence-via";
import {
  directionHidden,
  directionPlanned,
  gatesAnyMetric,
  lensHidden,
  lensPlanned,
  metricVisible,
  navPolicy,
  visibleMetricKeys,
  type InstanceNavPolicy,
} from "@/lib/portal/nav-policy";
import {
  DIRECTIONS,
  lensSlug,
  type Direction,
} from "@/lib/portal/nav-model";

export type ConcentrationFraming = "bus-factor" | "load-balance";

export type SectionSpec =
  | {
      kind: "headline";
      metrics: readonly string[];
      unattributed?: true;
      labelSource?: "short";
    }
  | { kind: "stat-tiles"; title: string; metrics: readonly string[] }
  | {
      kind: "trend";
      metrics: readonly string[];
      activeContributorsFor?: string;
    }
  | {
      kind: "distribution";
      metric: string;
      title: string;
      caption: string;
      unitLabel: string;
    }
  | {
      kind: "concentration";
      metrics: readonly string[];
      framing: ConcentrationFraming;
    }
  | {
      kind: "composition";
      metric: string;
      dimension: string;
      title: string;
      splitBy?: string;
      notes?: readonly string[];
    }
  | { kind: "event-histogram"; metric: string; title: string }
  | {
      kind: "dimension-table";
      title: string;
      dimension: string;
      metrics: readonly string[];
      noun: string;
      limit?: number;
    }
  | {
      kind: "ownership";
      metric: string;
      dimension: string;
      title: string;
    }
  | {
      kind: "contributors";
      metric: string;
      title: string;
      limit?: number;
    }
  | {
      kind: "heatmap-hours";
      metric: string;
      title: string;
      caption: string;
    }
  | {
      kind: "participation";
      metrics: readonly string[];
      title: string;
      noun: string;
    }
  | { kind: "attention"; metrics: readonly string[]; max: number }
  | { kind: "direction-cards"; variant: "compact" | "full" };

export interface LensConfig {
  title: DisplayText;
  tagline?: DisplayText;
  sections: readonly SectionSpec[];
  notIngested?: string;
  drilldown?: {
    dimension: string;
    tagline?: string;
    sections: readonly SectionSpec[];
  };
}

export interface LensRoadmap {
  comingSoon: string;
}

export interface TenantLensConfig {
  title: string;
  tagline?: string;
  entity: "tenant";
  sections: readonly TenantSectionSpec[];
  notIngested: string;
}

export type TenantSectionSpec =
  | { kind: "headline"; metrics: readonly string[] }
  | { kind: "stat-tiles"; title: string; metrics: readonly string[] }
  | {
      kind: "trend";
      title: string;
      description?: string;
      metrics: readonly string[];
      plot?: "line" | "step" | "area";
      referenceMean?: boolean;
      flagOutliers?: boolean;
    }
  | {
      kind: "composition";
      metric: string;
      dimension: string;
      title: string;
      splitBy?: string;
      segmentLabels?: Readonly<Record<string, string>>;
    }
  | { kind: "histogram"; metric: string; title: string; caption: string }
  | {
      kind: "stacked-trend";
      metric: string;
      splitBy: string;
      title: string;
      description?: string;
      share?: boolean;
      segmentLabels?: Readonly<Record<string, string>>;
    }
  | {
      kind: "small-multiples";
      metric: string;
      dimension: string;
      title: string;
      top?: number;
    }
  | {
      kind: "scatter";
      x: string;
      y: string;
      size?: string;
      dimension: string;
      title: string;
      description?: string;
      quadrants?: boolean;
    }
  | { kind: "heatmap-hours"; metric: string; title: string }
  | { kind: "hour-columns"; metric: string; title: string; description?: string }
  | {
      kind: "slope";
      metric: string;
      dimension: string;
      title: string;
      description?: string;
    }
  | {
      kind: "momentum";
      metric: string;
      dimension: string;
      title: string;
      description?: string;
    }
  | { kind: "marginal-impact"; title: string; description?: string }
  | { kind: "callout-pair"; metric: string; dimension: string; title: string }
  | {
      kind: "dumbbell";
      metric: string;
      dimension: string;
      splitBy: string;
      left: string;
      right: string;
      title: string;
      description?: string;
    }
  | { kind: "cumulative"; metric: string; dimension: string; title: string; description?: string }
  | {
      kind: "decomposition";
      metric: string;
      splitBy: string;
      title: string;
      segmentLabels?: Readonly<Record<string, string>>;
    }
  | {
      kind: "verdict-table";
      metric: string;
      dimension: string;
      title: string;
      description?: string;
      minWeeks?: number;
    };

export function tenantSectionMetricKeys(config: TenantLensConfig): string[] {
  const keys = new Set<string>();
  for (const s of config.sections) {
    switch (s.kind) {
      case "headline":
      case "stat-tiles":
      case "trend":
        for (const k of s.metrics) keys.add(k);
        break;
      case "composition":
      case "histogram":
      case "stacked-trend":
      case "small-multiples":
      case "heatmap-hours":
      case "hour-columns":
      case "slope":
      case "momentum":
      case "callout-pair":
      case "dumbbell":
      case "cumulative":
      case "decomposition":
      case "verdict-table":
        keys.add(s.metric);
        break;
      case "scatter":
        keys.add(s.x);
        keys.add(s.y);
        if (s.size) keys.add(s.size);
        break;
      case "marginal-impact":
        keys.add("ci.runs");
        break;
      default: {
        const _exhaustive: never = s;
        throw new Error(`Unhandled tenant section: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
  return [...keys];
}

export type LensEntry = LensConfig | LensRoadmap | TenantLensConfig;

export function isTenantLens(entry: LensEntry): entry is TenantLensConfig {
  return "entity" in entry;
}

export function lensEntry(dir: string, lens: string): LensEntry | undefined {
  return DIRECTION_LENSES[dir]?.[lens];
}

export function lensRoadmap(
  direction: Direction,
  lens: string,
  policy: InstanceNavPolicy = navPolicy()
): boolean {
  return (
    directionPlanned(direction.id, policy) ||
    lensPlanned(direction.id, lensSlug(lens), policy)
  );
}

export function visibleLenses(
  direction: Direction,
  showPlanned: boolean,
  policy: InstanceNavPolicy = navPolicy()
): string[] {
  return direction.lenses.filter((lens) => {
    if (lensHidden(direction.id, lensSlug(lens), policy)) return false;
    return !lensRoadmap(direction, lens, policy) || showPlanned;
  });
}

export function visibleDirections(
  showPlanned: boolean,
  policy: InstanceNavPolicy = navPolicy()
): Direction[] {
  return DIRECTIONS.filter(
    (d) =>
      !directionHidden(d.id, policy) &&
      visibleLenses(d, showPlanned, policy).length > 0
  );
}

export function overviewCardDirections(
  showPlanned: boolean,
  policy: InstanceNavPolicy = navPolicy()
): Direction[] {
  return visibleDirections(showPlanned, policy).filter((d) =>
    visibleLenses(d, showPlanned, policy).includes("Overview")
  );
}

export function sectionMetricKeys(config: LensConfig): string[] {
  const keys = new Set<string>();
  for (const s of [...config.sections, ...(config.drilldown?.sections ?? [])]) {
    switch (s.kind) {
      case "headline":
      case "stat-tiles":
      case "trend":
      case "concentration":
      case "participation":
      case "attention":
        for (const k of s.metrics) keys.add(k);
        break;
      case "distribution":
      case "composition":
      case "event-histogram":
      case "ownership":
      case "contributors":
      case "heatmap-hours":
        keys.add(s.metric);
        break;
      case "dimension-table":
        for (const k of s.metrics) keys.add(k);
        break;
      case "direction-cards":
        for (const lenses of Object.values(DIRECTION_LENSES)) {
          const overview = lenses["Overview"];
          if (!overview || "comingSoon" in overview) continue;
          for (const sec of overview.sections) {
            if (sec.kind === "headline")
              for (const k of sec.metrics) keys.add(k);
          }
        }
        break;
      default: {
        const _exhaustive: never = s;
        throw new Error(
          `Unhandled section kind: ${JSON.stringify(_exhaustive)}`
        );
      }
    }
  }
  return [...keys];
}

export function visibleSections(
  config: LensConfig,
  showPlanned: boolean,
  policy: InstanceNavPolicy = navPolicy()
): LensConfig {
  if (!gatesAnyMetric(policy)) return config;

  const sections: SectionSpec[] = [];
  for (const s of config.sections) {
    switch (s.kind) {
      case "headline":
      case "stat-tiles":
      case "trend":
      case "concentration":
      case "participation":
      case "attention": {
        const metrics = visibleMetricKeys(s.metrics, showPlanned, policy);
        if (metrics.length) sections.push({ ...s, metrics });
        break;
      }
      case "distribution":
      case "composition":
      case "event-histogram":
      case "ownership":
      case "contributors":
      case "heatmap-hours":
        if (metricVisible(s.metric, showPlanned, policy)) sections.push(s);
        break;
      case "dimension-table": {
        const metrics = visibleMetricKeys(s.metrics, showPlanned, policy);
        if (metrics.length) sections.push({ ...s, metrics });
        break;
      }
      case "direction-cards":
        sections.push(s);
        break;
      default: {
        const _exhaustive: never = s;
        throw new Error(
          `Unhandled section kind: ${JSON.stringify(_exhaustive)}`
        );
      }
    }
  }
  return { ...config, sections };
}

const PRODUCT_GAP = (what: string): LensRoadmap => ({
  comingSoon: `${what} — not available yet.`,
});

const SCREEN_GAP = (what: string): LensRoadmap => ({
  comingSoon: `${what} — the data is there (git observations carry the dimensions); this view is still in development.`,
});

const GIT_CATEGORY_NOTES = [
  "Every file gets one category, from its path — the first rule that matches wins.",
  "Vendored / Generated — dependency folders, build output, minified and generated files, lockfiles.",
  "Tests — files named *.test.* or *.spec.*, and anything under test/, tests/ or __tests__/.",
  "Documentation — .md, .rst and .adoc files, and anything under docs/.",
  "Configuration — .yaml, .toml, .cfg and .ini files, and lockfiles not already counted as generated.",
  "Code — whatever the other categories did not claim.",
] as const;

export const IN_FLIGHT_LENS = "Work in flight";

export const IN_FLIGHT_METRICS = {
  commits: "git.non_default_branch_commits",
  codeLines: "git.non_default_branch_code_lines",
  linesAdded: "git.non_default_branch_lines_added",
  prsCreated: "git.non_default_branch_prs_created",
  prsMerged: "git.non_default_branch_prs_merged",
} as const;

const DEV: Record<string, LensEntry> = {
  Overview: {
    title: "Development",
    tagline: "output, flow & balance",
    sections: [
      {
        kind: "headline",
        metrics: [
          "git.default_branch_prs_merged",
          "git.pr_size",
          "git.default_branch_lines_added",
          "git.reviews_performed",
        ],
      },
      {
        kind: "stat-tiles",
        title: "Typical values (median)",
        metrics: ["git.pr_cycle_time_h", "git.default_branch_merge_rate"],
      },
      {
        kind: "trend",
        metrics: ["git.default_branch_prs_created", "git.default_branch_prs_merged"],
      },
      {
        kind: "concentration",
        metrics: ["git.default_branch_prs_merged"],
        framing: "bus-factor",
      },
      {
        kind: "composition",
        metric: "git.default_branch_lines_added",
        dimension: "category",
        title: "Lines by category",
        notes: GIT_CATEGORY_NOTES,
      },
    ],
  },
  "Git output": {
    title: "Development · Git output",
    sections: [
      {
        kind: "headline",
        labelSource: "short",
        metrics: [
          "git.default_branch_prs_merged",
          "git.default_branch_prs_created",
          "git.pr_size",
          "git.default_branch_code_lines",
        ],
      },
      {
        kind: "trend",
        metrics: ["git.default_branch_prs_merged"],
      },
      {
        kind: "concentration",
        metrics: ["git.default_branch_prs_merged"],
        framing: "bus-factor",
      },
      {
        kind: "contributors",
        metric: "git.default_branch_prs_merged",
        title: "PRs merged per person",
        limit: Infinity,
      },
      {
        kind: "composition",
        metric: "git.default_branch_lines_added",
        dimension: "repository",
        splitBy: "category",
        title: "Lines by repository",
      },
    ],
  },
  [IN_FLIGHT_LENS]: {
    title: "Development · Work in flight",
    tagline: "not on the default branch yet",
    sections: [
      {
        kind: "headline",
        labelSource: "short",
        metrics: [
          IN_FLIGHT_METRICS.commits,
          IN_FLIGHT_METRICS.codeLines,
          IN_FLIGHT_METRICS.prsCreated,
          IN_FLIGHT_METRICS.prsMerged,
        ],
      },
      { kind: "trend", metrics: [IN_FLIGHT_METRICS.commits] },
      {
        kind: "distribution",
        metric: IN_FLIGHT_METRICS.commits,
        title: "Who has commits in flight",
        caption: "How many people fall in each band of commits not yet on the default branch.",
        unitLabel: "commits in flight per person",
      },
      {
        kind: "composition",
        metric: IN_FLIGHT_METRICS.linesAdded,
        dimension: "repository",
        splitBy: "category",
        title: "Lines in flight by repository",
      },
    ],
  },
  Flow: {
    title: "Development · Flow",
    tagline: "how smoothly work moves",
    sections: [
      {
        kind: "stat-tiles",
        title: "Typical values (median)",
        metrics: [
          "git.pr_cycle_time_h",
          "git.pr_size",
          "git.commit_size",
          "git.default_branch_merge_rate",
          "git.default_branch_commits_per_active_day",
        ],
      },
      {
        kind: "event-histogram",
        metric: "git.pr_cycle_time_h",
        title: "How long pull requests stayed open",
      },
      {
        kind: "event-histogram",
        metric: "git.pr_size",
        title: "How large pull requests were",
      },
    ],
  },
  Delivery: {
    title: "Development · Delivery",
    notIngested: "Jira is not connected yet.",
    sections: [
      {
        kind: "headline",
        metrics: ["tasks.closed", "tasks.bugs_fixed", "tasks.logged_hours"],
        unattributed: true,
      },
      {
        kind: "stat-tiles",
        title: "Typical task times (median)",
        metrics: ["tasks.resolution_time", "tasks.pickup_time"],
      },
      { kind: "trend", metrics: ["tasks.closed", "tasks.bugs_fixed"] },
      {
        kind: "distribution",
        metric: "tasks.closed",
        title: "How many tasks people closed",
        caption:
          "Each bar is a range of tasks closed, and how many people fall in it.",
        unitLabel: "tasks closed per person",
      },
    ],
  },
  Activity: PRODUCT_GAP("Per-person activity-day metrics"),
  Quality: {
    title: "Development · Quality",
    tagline: "review hygiene & timing",
    sections: [
      {
        kind: "headline",
        metrics: ["git.reviews_performed", "git.pr_comments"],
      },
      {
        kind: "composition",
        metric: "git.pr_comments",
        dimension: "comment_target",
        title: "PR comments — own vs others' pull requests",
      },
      {
        kind: "stat-tiles",
        title: "Review hygiene (median across people)",
        metrics: [
          "git.review_coverage",
          "git.reviewers_per_pr",
          "git.multi_reviewer_rate",
          "git.merges_without_approval_rate",
        ],
      },
      {
        kind: "stat-tiles",
        title: "Review timing (median across people)",
        metrics: [
          "git.first_review_time_h",
          "git.first_review_time_p75_h",
          "git.review_to_merge_time_h",
          "git.approval_to_merge_time_h",
          "git.review_wait_share",
        ],
      },
      { kind: "trend", metrics: ["git.review_coverage"] },
      {
        kind: "event-histogram",
        metric: "git.first_review_time_h",
        title: "How long pull requests waited for the first review",
      },
      {
        kind: "stat-tiles",
        title: "Outcomes (median across people)",
        metrics: ["git.default_branch_merge_rate", "git.pr_abandonment_rate"],
      },
    ],
  },
  CI: {
    title: "Development · CI",
    tagline: "pipelines, org-wide",
    entity: "tenant",
    notIngested:
      "No CI metrics here yet — tenant metrics are opt-in per installation (metricCatalog.tenantMetricsEnabled), and a GitHub source must be collecting runs.",
    sections: [
      {
        kind: "headline",
        metrics: ["ci.gate_pass_rate", "ci.runs", "ci.gate_first_try_pass_rate"],
      },
      {
        kind: "stat-tiles",
        title: "Gate run durations & retries",
        metrics: [
          "ci.run_duration_min",
          "ci.run_duration_min_p90",
          "ci.run_duration_min_stddev",
          "ci.gate_retry_share",
        ],
      },
      {
        kind: "trend",
        title: "Runs over time",
        description: "Decided runs, all triggers.",
        metrics: ["ci.runs"],
        plot: "area",
      },
      {
        kind: "trend",
        title: "Gate pass rate over time",
        description:
          "Success share of commit-triggered runs; first-try shows what green cost in retries.",
        metrics: ["ci.gate_pass_rate", "ci.gate_first_try_pass_rate"],
      },
      {
        kind: "composition",
        metric: "ci.runs",
        dimension: "repository",
        splitBy: "outcome",
        title: "Runs by repository",
      },
      {
        kind: "composition",
        metric: "ci.run_hours",
        dimension: "repository",
        splitBy: "outcome",
        title: "CI hours by repository",
      },
      {
        kind: "trend",
        title: "CI ↔ commit join coverage",
        description:
          "Runs, collected commits, and runs whose head commit was collected — the gap is data the two streams cannot join.",
        metrics: [
          "ci.runs",
          "ci.commits_observed",
          "ci.runs_matched_commit",
        ],
      },
      {
        kind: "histogram",
        metric: "ci.run_duration_min",
        title: "How long a gate run takes",
        caption:
          "Each bar is a duration range, and how many runs fall in it. The tail is what people wait for.",
      },
      {
        kind: "composition",
        metric: "ci.deployments",
        dimension: "environment",
        splitBy: "outcome",
        title: "Deployments by environment",
        // WORKAROUND: GitHub marks a deployment superseded by a newer one "inactive".
        segmentLabels: { inactive: "superseded" },
      },
      {
        kind: "stacked-trend",
        metric: "ci.runs",
        splitBy: "outcome",
        title: "Run outcomes over time",
        description: "Every decided run classified, nothing dropped.",
      },
      {
        kind: "stacked-trend",
        metric: "ci.runs",
        splitBy: "outcome",
        share: true,
        title: "Outcome mix as shares",
        description: "The same runs, composition instead of volume.",
      },
      {
        kind: "trend",
        title: "Median gate run duration",
        description: "A step reads as \"held at\", not \"drifted to\".",
        metrics: ["ci.run_duration_min"],
        plot: "step",
      },
      {
        kind: "trend",
        title: "Gate pass rate against its window mean",
        description:
          "The rule is the window average; flagged buckets fell 2σ below their own trailing mean.",
        metrics: ["ci.gate_pass_rate"],
        referenceMean: true,
        flagOutliers: true,
      },
      {
        kind: "small-multiples",
        metric: "ci.runs",
        dimension: "repository",
        title: "Runs per repository",
        top: 12,
      },
      {
        kind: "slope",
        metric: "ci.gate_pass_rate",
        dimension: "repository",
        title: "Pass rate, first half against second half",
        description: "The window split at its midpoint; direction labelled, not colour-only.",
      },
      {
        kind: "momentum",
        metric: "ci.gate_pass_rate",
        dimension: "repository",
        title: "Momentum: second half against the first",
        description: "Change in pass rate, in points.",
      },
      {
        kind: "scatter",
        x: "ci.runs",
        y: "ci.gate_pass_rate",
        size: "ci.run_hours",
        dimension: "repository",
        title: "Volume against reliability",
        description: "Bubble area is CI hours consumed.",
      },
      {
        kind: "scatter",
        x: "ci.run_duration_min",
        y: "ci.gate_pass_rate",
        size: "ci.run_hours",
        dimension: "pipeline",
        title: "Slow and red — where to spend the effort",
        description: "Median duration against pass rate; bubble area is CI hours.",
        quadrants: true,
      },
      {
        kind: "heatmap-hours",
        metric: "ci.runs",
        title: "When CI actually runs",
      },
      {
        kind: "hour-columns",
        metric: "ci.gate_pass_rate",
        title: "Is CI riskier at some hours?",
        description: "Pass rate by two-hour block of the run's start, UTC; the band is ±1σ around the mean.",
      },
      {
        kind: "marginal-impact",
        title: "What fixing the worst pipelines would buy",
        description:
          "Gate pass rate if the top N failing pipelines produced no failures.",
      },
      {
        kind: "callout-pair",
        metric: "ci.gate_pass_rate",
        dimension: "repository",
        title: "Headline rate versus typical repository",
      },
      {
        kind: "dumbbell",
        metric: "ci.run_duration_min",
        dimension: "pipeline",
        splitBy: "outcome",
        left: "failure",
        right: "success",
        title: "Does a pipeline fail fast, or fail slow?",
        description: "Median duration of failing runs against passing runs.",
      },
      {
        kind: "cumulative",
        metric: "ci.run_hours",
        dimension: "pipeline",
        title: "Compute concentrates harder than failure does",
        description: "Cumulative share of all CI hours across pipelines, busiest first.",
      },
      {
        kind: "decomposition",
        metric: "ci.run_hours",
        splitBy: "outcome",
        title: "Where the CI hours actually went",
      },
      {
        kind: "verdict-table",
        metric: "ci.gate_pass_rate",
        dimension: "pipeline",
        title: "Stability verdict per pipeline",
        description:
          "Mean weekly pass rate and its volatility resolve to a verdict; thin histories stay unjudged.",
        minWeeks: 5,
      },
    ],
  },
  Continuity: PRODUCT_GAP("Longitudinal continuity metrics"),
  Repositories: {
    title: "Development · Repositories",
    tagline: "activity, reach & risk",
    sections: [
      {
        kind: "headline",
        metrics: [
          "git.default_branch_prs_merged",
          "git.default_branch_code_lines",
        ],
      },
      {
        kind: "trend",
        metrics: ["git.default_branch_prs_created", "git.default_branch_prs_merged"],
        activeContributorsFor: "git.default_branch_prs_merged",
      },
      {
        kind: "stat-tiles",
        title: "Typical values (median)",
        metrics: [
          "git.pr_cycle_time_h",
          "git.pr_cycle_time_p75_h",
          "git.pr_size",
          "git.pr_commits",
          "git.default_branch_merge_rate",
          "git.default_branch_commits_per_active_day",
        ],
      },
      {
        kind: "composition",
        metric: "git.default_branch_prs_merged",
        dimension: "repository",
        title: "PRs merged by repository",
      },
      {
        kind: "dimension-table",
        title: "Repositories · ranked by PRs merged",
        dimension: "repository",
        noun: "repositories",
        metrics: [
          "git.default_branch_prs_merged",
          "git.default_branch_lines_added",
          "git.default_branch_lines_removed",
          "git.pr_cycle_time_h",
          "git.pr_commits",
        ],
      },
      {
        kind: "ownership",
        metric: "git.default_branch_code_lines",
        dimension: "repository",
        title: "Ownership concentration — share of lines by top contributors",
      },
      {
        kind: "event-histogram",
        metric: "git.pr_cycle_time_h",
        title: "How long pull requests stayed open",
      },
    ],
    drilldown: {
      dimension: "repository",
      tagline: "one repository",
      sections: [
        {
          kind: "headline",
          metrics: [
            "git.default_branch_prs_merged",
            "git.default_branch_commits",
            "git.default_branch_code_lines",
          ],
        },
        {
          kind: "stat-tiles",
          title: "Typical values (median)",
          metrics: [
            "git.pr_cycle_time_h",
            "git.pr_cycle_time_p75_h",
            "git.pr_size",
            "git.pr_commits",
            "git.default_branch_merge_rate",
            "git.review_coverage",
          ],
        },
        {
          kind: "contributors",
          metric: "git.default_branch_code_lines",
          title: "Top contributors — code lines on the default branch",
        },
        {
          kind: "heatmap-hours",
          metric: "git.default_branch_commits",
          title: "When commits were made",
          caption:
            "Weekday × two-hour block, in UTC. Click a block for its commits.",
        },
        {
          kind: "ownership",
          metric: "git.default_branch_code_lines",
          dimension: "repository",
          title: "Ownership concentration",
        },
        {
          kind: "event-histogram",
          metric: "git.pr_cycle_time_h",
          title: "How long pull requests stayed open",
        },
      ],
    },
  },
  Elements: SCREEN_GAP("Element-level (file/module) analytics"),
};

const COLLAB: Record<string, LensEntry> = {
  Overview: {
    title: "Collaboration",
    sections: [
      {
        kind: "headline",
        metrics: [
          "collab.messages_sent",
          "collab.meeting_hours",
          "collab.focus_time_pct",
        ],
      },
      {
        kind: "trend",
        metrics: ["collab.messages_sent", "collab.meeting_hours"],
      },
      {
        kind: "distribution",
        metric: "collab.meeting_hours",
        title: "How many hours people spent in meetings",
        caption:
          "How many people fall in each meeting-hours band — a long right tail means a few people carry an outsized meeting load.",
        unitLabel: "meeting hours per person",
      },
      {
        kind: "concentration",
        metrics: ["collab.meeting_hours", "collab.messages_sent"],
        framing: "load-balance",
      },
    ],
  },
  Messaging: {
    title: "Messaging",
    sections: [
      {
        kind: "headline",
        metrics: [
          "collab.messages_sent",
          "collab.msgs_per_active_day",
          "collab.chat_active_days",
          "collab.active_days",
        ],
      },
      { kind: "trend", metrics: ["collab.messages_sent"] },
      {
        kind: "distribution",
        metric: "collab.messages_sent",
        title: "How many chat messages people sent",
        caption:
          "How many people fall in each message-volume band — a long right tail means a few people account for most of the chatter.",
        unitLabel: "chat messages per person",
      },
      {
        kind: "concentration",
        metrics: ["collab.messages_sent"],
        framing: "load-balance",
      },
    ],
  },
  Meetings: {
    title: "Meetings",
    sections: [
      {
        kind: "headline",
        metrics: [
          "collab.meeting_hours",
          "collab.meetings_count",
          "collab.meeting_free_days",
        ],
      },
      { kind: "trend", metrics: ["collab.meeting_hours"] },
      {
        kind: "distribution",
        metric: "collab.meeting_hours",
        title: "How many hours people spent in meetings",
        caption:
          "How many people fall in each meeting-hours band — a long right tail means a few people carry an outsized meeting load.",
        unitLabel: "meeting hours per person",
      },
      {
        kind: "concentration",
        metrics: ["collab.meeting_hours"],
        framing: "load-balance",
      },
    ],
  },
  Email: {
    title: "Email",
    sections: [
      {
        kind: "headline",
        metrics: ["collab.emails_sent", "collab.emails_read"],
      },
      { kind: "trend", metrics: ["collab.emails_sent"] },
      {
        kind: "distribution",
        metric: "collab.emails_sent",
        title: "How many emails people sent",
        caption:
          "How many people fall in each sent-email band — a long right tail means a few people send most of the email.",
        unitLabel: "emails sent per person",
      },
      {
        kind: "concentration",
        metrics: ["collab.emails_sent"],
        framing: "load-balance",
      },
    ],
  },
  "Time outside meetings": {
    title: "Time outside meetings",
    sections: [
      {
        kind: "headline",
        metrics: ["collab.focus_time_pct", "collab.meeting_free_days"],
      },
      {
        kind: "distribution",
        metric: "collab.focus_time_pct",
        title: "How much of the workday people had outside meetings",
        caption:
          "How many people fall in each band of time outside meetings — a cluster on the left means many people spend most of their scheduled hours in meetings.",
        unitLabel: "share of scheduled hours outside meetings per person",
      },
    ],
  },
  "Files & sharing": {
    title: "Files & sharing",
    sections: [
      {
        kind: "headline",
        metrics: [
          "collab.files_shared",
          "collab.files_engaged",
          "collab.files_shared_external",
        ],
      },
      { kind: "trend", metrics: ["collab.files_shared"] },
      {
        kind: "distribution",
        metric: "collab.files_shared",
        title: "How many files people shared",
        caption:
          "How many people fall in each files-shared band — a long right tail means a few people do most of the sharing.",
        unitLabel: "files shared per person",
      },
      {
        kind: "concentration",
        metrics: ["collab.files_shared"],
        framing: "load-balance",
      },
    ],
  },
};

const WIKI: Record<string, LensEntry> = {
  Overview: {
    title: "Knowledge / Wiki",
    sections: [
      {
        kind: "headline",
        metrics: ["wiki.pages_created", "wiki.edits", "wiki.comments"],
      },
      { kind: "trend", metrics: ["wiki.pages_created", "wiki.edits"] },
      {
        kind: "distribution",
        metric: "wiki.edits",
        title: "How many wiki edits people made",
        caption:
          "How many people fall in each wiki-edits band — a long right tail means knowledge writing is concentrated in a few hands.",
        unitLabel: "wiki edits per person",
      },
      { kind: "concentration", metrics: ["wiki.edits"], framing: "bus-factor" },
    ],
  },
  Authoring: {
    title: "Wiki · Authoring",
    sections: [
      {
        kind: "headline",
        metrics: ["wiki.pages_created", "wiki.pages_edited"],
      },
      {
        kind: "distribution",
        metric: "wiki.pages_created",
        title: "How many pages people created",
        caption:
          "Each bar is a range of pages created, and how many people fall in it.",
        unitLabel: "pages created per person",
      },
      {
        kind: "concentration",
        metrics: ["wiki.pages_created"],
        framing: "bus-factor",
      },
    ],
  },
  "Edits & comments": {
    title: "Wiki · Edits & comments",
    sections: [
      { kind: "headline", metrics: ["wiki.edits", "wiki.comments"] },
      { kind: "trend", metrics: ["wiki.edits", "wiki.comments"] },
      {
        kind: "distribution",
        metric: "wiki.edits",
        title: "How many wiki edits people made",
        caption:
          "Each bar is a range of wiki edits, and how many people fall in it.",
        unitLabel: "wiki edits per person",
      },
    ],
  },
  "Active authors": {
    title: "Wiki · Active authors",
    tagline: "who writes at all",
    sections: [
      {
        kind: "participation",
        metrics: ["wiki.pages_created", "wiki.edits", "wiki.comments"],
        title: "Participation",
        noun: "Active authors",
      },
      { kind: "trend", metrics: ["wiki.edits"] },
    ],
  },
};

const SALES_NOTE: LensRoadmap = {
  comingSoon: "HubSpot data is not available yet.",
};
const SUPPORT_NOTE: LensRoadmap = {
  comingSoon: "Zendesk data is not available yet.",
};

const SALES: Record<string, LensEntry> = Object.fromEntries(
  ["Pipeline", "Deal flow", "Activity", "Velocity & quality"].map((l) => [
    l,
    SALES_NOTE,
  ])
);
const SUPPORT: Record<string, LensEntry> = Object.fromEntries(
  ["Tickets", "CSAT", "Knowledge base", "Comments & updates"].map((l) => [
    l,
    SUPPORT_NOTE,
  ])
);

export const DIRECTION_LENSES: Record<string, Record<string, LensEntry>> = {
  dev: DEV,
  collab: COLLAB,
  wiki: WIKI,
  sales: SALES,
  support: SUPPORT,
};

export function directionMetricKeys(dir: string): string[] {
  const keys = new Set<string>();
  for (const entry of Object.values(DIRECTION_LENSES[dir] ?? {})) {
    if ("comingSoon" in entry || isTenantLens(entry)) continue;
    for (const k of sectionMetricKeys(entry)) keys.add(k);
  }
  for (const carrier of evidenceCarriers([...keys])) keys.add(carrier);
  return [...keys];
}
