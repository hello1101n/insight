import type {
  Dashboard,
  DashboardWidget,
  MetricResult,
} from "@/api/custom-client";

/*
 * Prototype: example dashboards for comparing the current renderer with
 * FrontX. Every number is synthetic, and each answer grows with the window so
 * a range change shows.
 *
 * Insight percent columns hold 0 to 100. A widget's `percents` stands for the
 * field the widgets answer would need to carry; the service does not send it.
 */

export interface ExampleDashboard {
  name: string;
  body: Dashboard;
}

/** A run answer: the result, or a refusal with its status. */
export type ExampleAnswer =
  { result: MetricResult } | { status: number; body: { detail: string } };

const clock = { field: "day", from: "metric" } as const;
const DAYS: Record<string, number> = { P7D: 7, P30D: 30, PQC: 91, P1Y: 365 };
const TEAMS = ["Atlas", "Borealis", "Cobalt", "Delta"];
const SIX_TEAMS = [...TEAMS, "Ember", "Fjord"];
const SEVERITIES = ["critical", "major", "minor", "cosmetic"];
const REPOSITORIES = [
  "api-gateway",
  "billing",
  "web-app",
  "mobile-app",
  "search",
  "notifications",
  "auth",
  "reporting",
  "data-pipeline",
  "design-system",
  "infra",
  "docs",
  "cli",
  "sdk",
];
const SERVICES = [
  "checkout-orchestrator",
  "inventory-reconciliation",
  "customer-profile-sync",
  "payment-retry-scheduler",
  "shipment-label-renderer",
  "fraud-signal-collector",
  "recommendation-feed",
  "email-digest-builder",
  "price-rule-evaluator",
  "warehouse-slot-planner",
  "support-ticket-router",
  "loyalty-points-ledger",
  "returns-intake",
  "catalog-image-resizer",
  "tax-rate-lookup",
  "session-cleanup-job",
];
const PIPELINES = ["build", "unit", "e2e", "lint", "deploy", "docs"];
const OUTCOMES = ["passed", "failed", "cancelled"];

const widget = (
  id: string,
  name: string,
  body: DashboardWidget["body"],
  extra: Partial<DashboardWidget> = { clock }
): DashboardWidget => ({ id, name, body, ...extra });

export const EXAMPLE_WIDGETS: DashboardWidget[] = [
  // delivery-pulse
  widget("pulse-deploys", "Deploys", {
    type: "stat",
    metric: "pulse",
    value: "deploys",
    label: "deploys in the window",
  }),
  widget(
    "pulse-failure-rate",
    "Change failure rate",
    {
      type: "stat",
      metric: "pulse",
      value: "rate",
      label: "of deploys failed",
    },
    { clock, percents: ["rate"] }
  ),
  widget("pulse-deploys-per-day", "Deploys per day", {
    type: "line",
    metric: "pulse",
    x: "bucket",
    y: "deploys",
  }),
  widget("pulse-open-prs", "Open pull requests", {
    type: "area",
    metric: "pulse",
    x: "bucket",
    y: "open",
  }),
  widget("pulse-deploys-by-team", "Deploys by team", {
    type: "bar",
    metric: "pulse",
    x: "team",
    y: "deploys",
    labels: true,
  }),
  widget("pulse-deploys-by-outcome", "Deploys by team and outcome", {
    type: "bar",
    metric: "pulse",
    x: "team",
    y: "deploys",
    series: "outcome",
  }),
  widget(
    "pulse-prs-by-state",
    "Pull requests by state",
    { type: "pie", metric: "pulse", label: "state", value: "count" },
    { clock: null }
  ),
  widget("pulse-slow-pipelines", "Slowest pipelines", {
    type: "table",
    metric: "pulse",
    columns: ["pipeline", "median_minutes", "runs"],
  }),

  // kpi-overview
  widget("kpi-contributors", "Active contributors", {
    type: "stat",
    metric: "kpi",
    value: "people",
    label: "people with a commit",
  }),
  widget(
    "kpi-pass-rate",
    "Test pass rate",
    { type: "stat", metric: "kpi", value: "pass_rate", label: "of test runs" },
    { clock, percents: ["pass_rate"] }
  ),
  widget(
    "kpi-flaky-rate",
    "Flaky test rate",
    { type: "stat", metric: "kpi", value: "flaky_rate", label: "of tests" },
    { clock, percents: ["flaky_rate"] }
  ),
  widget("kpi-spend", "Cloud spend", {
    type: "stat",
    metric: "kpi",
    value: "spend",
    label: "USD in the window",
  }),
  widget("kpi-cost-per-deploy", "Cost per deploy", {
    type: "stat",
    metric: "kpi",
    value: "cost",
    label: "USD",
  }),
  widget("kpi-lines", "Lines changed", {
    type: "stat",
    metric: "kpi",
    value: "lines",
  }),
  widget("kpi-backlog", "Net backlog change", {
    type: "stat",
    metric: "kpi",
    value: "change",
    label: "issues",
  }),
  widget("kpi-restore", "Mean time to restore", {
    type: "stat",
    metric: "kpi",
    value: "hours",
    label: "hours, no incident in the window",
  }),

  // breakdowns
  widget("bd-incidents", "Incidents by team and severity", {
    type: "bar",
    metric: "bd",
    x: "team",
    y: "incidents",
    series: "severity",
  }),
  widget("bd-reviews", "Reviews by team", {
    type: "bar",
    metric: "bd",
    x: "team",
    y: "reviews",
    labels: true,
  }),
  widget(
    "bd-wait-share",
    "Share of pull requests that waited a day for review",
    { type: "bar", metric: "bd", x: "team", y: "share", labels: true },
    { clock, percents: ["share"] }
  ),
  widget("bd-repositories", "Commits by repository", {
    type: "pie",
    metric: "bd",
    label: "repository",
    value: "commits",
  }),
  widget(
    "bd-environments",
    "Share of deploys by environment",
    { type: "pie", metric: "bd", label: "environment", value: "share" },
    { clock: null, percents: ["share"] }
  ),
  widget("bd-services", "Deploys by service", {
    type: "bar",
    metric: "bd",
    x: "service",
    y: "deploys",
  }),

  // trends
  widget("tr-deploys", "Deploys per day", {
    type: "line",
    metric: "tr",
    x: "bucket",
    y: "deploys",
  }),
  widget("tr-lead-time", "Lead time, hours", {
    type: "area",
    metric: "tr",
    x: "bucket",
    y: "hours",
  }),
  widget(
    "tr-success",
    "Build success rate",
    { type: "line", metric: "tr", x: "bucket", y: "success" },
    { clock, percents: ["success"] }
  ),
  widget("tr-merged", "Merged pull requests per day", {
    type: "bar",
    metric: "tr",
    x: "bucket",
    y: "merged",
  }),
  widget("tr-queue", "Queue depth, with gaps where the collector was down", {
    type: "line",
    metric: "tr",
    x: "bucket",
    y: "queued",
  }),

  // pipeline-runs
  widget(
    "pr-all-runs",
    "All pipeline runs",
    {
      type: "table",
      metric: "runs",
      columns: [
        "run_id",
        "pipeline",
        "branch",
        "commit",
        "author",
        "started_at",
        "duration_min",
        "queue_min",
        "stages",
        "retries",
        "outcome",
        "success_rate",
      ],
    },
    { clock: null, percents: ["success_rate"] }
  ),
  widget(
    "pr-slow-stages",
    "Slowest stages",
    {
      type: "table",
      metric: "runs",
      columns: ["stage", "pipeline", "p50_min", "p95_min", "share"],
    },
    { clock: null, percents: ["share"] }
  ),
  widget(
    "pr-runs-per-week",
    "Runs per week",
    { type: "line", metric: "runs", x: "week", y: "runs" },
    { clock: null }
  ),

  // edge-cases
  widget(
    "edge-long-title",
    "Deploys to the staging environment that a person approved by hand, counted per day across every team",
    { type: "line", metric: "edge", x: "bucket", y: "deploys" }
  ),
  widget("edge-long-label", "Approvals", {
    type: "stat",
    metric: "edge",
    value: "approvals",
    label:
      "approvals that a person gave by hand after the automatic checks had already passed",
  }),
  widget("edge-empty-line", "Rollbacks per day", {
    type: "line",
    metric: "edge",
    x: "bucket",
    y: "rollbacks",
  }),
  widget("edge-empty-table", "Open incidents", {
    type: "table",
    metric: "edge",
    columns: ["incident", "opened", "severity"],
  }),
  widget("edge-failed", "Error budget left", {
    type: "stat",
    metric: "edge",
    value: "budget",
  }),
  widget("edge-busy", "Queue wait by runner", {
    type: "bar",
    metric: "edge",
    x: "runner",
    y: "minutes",
  }),
  widget("edge-missing-column", "Incidents by cause", {
    type: "pie",
    metric: "edge",
    label: "cause",
    value: "count",
  }),
];

export const EXAMPLE_DASHBOARDS: Record<string, ExampleDashboard> = {
  "delivery-pulse": {
    name: "Delivery pulse",
    body: {
      title: "Delivery pulse",
      time_ranges: ["P7D", "P30D", "P1Y"],
      default_range: "P30D",
      items: [
        { heading: "Throughput" },
        { widget: "pulse-deploys" },
        { widget: "pulse-failure-rate" },
        { widget: "pulse-deploys-per-day" },
        { widget: "pulse-open-prs" },
        { heading: "Breakdown" },
        { text: "Synthetic numbers for comparing the two renderers." },
        { widget: "pulse-deploys-by-team" },
        { widget: "pulse-deploys-by-outcome" },
        { widget: "pulse-prs-by-state" },
        { widget: "pulse-slow-pipelines" },
      ],
    },
  },
  "kpi-overview": {
    name: "KPI overview",
    body: {
      title: "KPI overview",
      time_ranges: ["P7D", "P30D"],
      default_range: "P30D",
      items: [
        { heading: "People and quality" },
        { widget: "kpi-contributors" },
        { widget: "kpi-pass-rate" },
        { widget: "kpi-flaky-rate" },
        { widget: "kpi-lines" },
        { heading: "Cost and flow" },
        { widget: "kpi-spend" },
        { widget: "kpi-cost-per-deploy" },
        { widget: "kpi-backlog" },
        { widget: "kpi-restore" },
      ],
    },
  },
  breakdowns: {
    name: "Breakdowns",
    body: {
      title: "Breakdowns",
      time_ranges: ["P30D", "PQC"],
      default_range: "P30D",
      items: [
        {
          text: "A bar with a series column stacks. Insight widgets have no grouped bar and no line or area with several series.",
        },
        { widget: "bd-incidents" },
        { widget: "bd-reviews" },
        { widget: "bd-wait-share" },
        { widget: "bd-repositories" },
        { widget: "bd-environments" },
        { widget: "bd-services" },
      ],
    },
  },
  trends: {
    name: "Trends",
    body: {
      title: "Trends",
      time_ranges: ["P7D", "P30D", "PQC"],
      default_range: "PQC",
      items: [
        { widget: "tr-deploys" },
        { widget: "tr-lead-time" },
        { widget: "tr-success" },
        { widget: "tr-merged" },
        { widget: "tr-queue" },
      ],
    },
  },
  "pipeline-runs": {
    name: "Pipeline runs",
    body: {
      title:
        "Pipeline runs: every run of every pipeline last quarter, with its timings and outcome",
      items: [
        { widget: "pr-all-runs" },
        { widget: "pr-slow-stages" },
        { widget: "pr-runs-per-week" },
      ],
    },
  },
  "edge-cases": {
    name: "Edge cases",
    body: {
      title: "Edge cases",
      time_ranges: ["P7D", "P30D"],
      default_range: "P30D",
      items: [
        {
          heading:
            "A heading long enough to wrap onto a second line when the window is narrow",
        },
        {
          text: "This text is long on purpose. It checks how each renderer wraps a paragraph that runs past one line. The widgets below answer with no rows, refuse the run, ask the reader to try again later, or name a column that the metric does not return. A reader should still see every other widget on the board, and each failed widget should say what went wrong in words a person can act on.",
        },
        { widget: "edge-long-title" },
        { widget: "edge-long-label" },
        { widget: "edge-empty-line" },
        { widget: "edge-empty-table" },
        { widget: "edge-failed" },
        { widget: "edge-busy" },
        { widget: "edge-missing-column" },
      ],
    },
  },
  "reading-notes": {
    name: "Reading notes",
    body: {
      title: "Reading notes",
      items: [
        { heading: "How to read these boards" },
        {
          text: "Each board answers one question. Start with the numbers at the top, then read the charts under them.",
        },
        { heading: "Where the numbers come from" },
        {
          text: "Every number on the example boards is synthetic. The mock service worker makes it up from the selected window.",
        },
        { heading: "What to do next" },
        { text: "Open a board and change the window to see what moves." },
      ],
    },
  },
};

function buckets(days: number, limit = 90): string[] {
  return Array.from({ length: Math.min(days, limit) }, (_, i) =>
    new Date(Date.UTC(2026, 9, 1) + i * 86_400_000).toISOString().slice(0, 10)
  );
}

const wave = (i: number) => Math.round(6 + 4 * Math.sin(i / 3) + (i % 5));
const round1 = (value: number) => Math.round(value * 10) / 10;

function pipelineRun(i: number): unknown[] {
  const started = new Date(Date.UTC(2026, 6, 1) + i * 3_600_000 * 3.3);
  return [
    `run-${String(10_000 + i)}`,
    PIPELINES[i % PIPELINES.length],
    i % 7 === 0 ? "release/2026.10" : `feature/change-${(i * 37) % 500}`,
    ((i * 2_654_435_761) >>> 0).toString(16).padStart(8, "0"),
    `dev-${(i * 13) % 40}`,
    started.toISOString().slice(0, 16).replace("T", " "),
    round1(4 + ((i * 7) % 50) / 3),
    round1(((i * 11) % 30) / 4),
    3 + (i % 6),
    i % 9 === 0 ? 1 : 0,
    OUTCOMES[i % 11 === 0 ? 1 : i % 17 === 0 ? 2 : 0],
    round1(80 + ((i * 19) % 200) / 10),
  ];
}

const result = (columns: string[], rows: unknown[][]): ExampleAnswer => ({
  result: { columns, rows },
});

/** What the run of an example widget answers over a window, or nothing for another widget. */
export function exampleRun(
  id: string,
  range: string | undefined
): ExampleAnswer | undefined {
  const days = DAYS[range ?? ""] ?? 30;
  const span = buckets(days);
  const total = span.reduce((sum, _, i) => sum + wave(i), 0);

  switch (id) {
    case "pulse-deploys":
      return result(["deploys"], [[total]]);
    case "pulse-failure-rate":
      return result(["rate"], [[round1(12 + days / 37.5)]]);
    case "pulse-deploys-per-day":
      return result(
        ["bucket", "deploys"],
        buckets(days, 60).map((day, i) => [day, wave(i)])
      );
    case "pulse-open-prs":
      return result(
        ["bucket", "open"],
        buckets(days, 60).map((day, i) => [day, 20 + wave(i * 2)])
      );
    case "pulse-deploys-by-team":
      return result(
        ["team", "deploys"],
        TEAMS.map((team, i) => [team, Math.round(total / (i + 2))])
      );
    case "pulse-deploys-by-outcome":
      return result(
        ["team", "outcome", "deploys"],
        TEAMS.flatMap((team, i) => [
          [team, "succeeded", Math.round(total / (i + 2))],
          [team, "failed", Math.round(total / (i + 2) / 8)],
        ])
      );
    case "pulse-prs-by-state":
      return result(
        ["state", "count"],
        [
          ["open", 42],
          ["merged", 318],
          ["closed", 57],
        ]
      );
    case "pulse-slow-pipelines":
      return result(
        ["pipeline", "median_minutes", "runs"],
        PIPELINES.slice(0, 5).map((name, i) => [
          name,
          30 - i * 5,
          Math.round(days * (i + 1)),
        ])
      );

    case "kpi-contributors":
      return result(["people"], [[Math.round(20 + days * 0.8)]]);
    case "kpi-pass-rate":
      return result(["pass_rate"], [[round1(97.3 - days / 100)]]);
    case "kpi-flaky-rate":
      return result(["flaky_rate"], [[2.35]]);
    case "kpi-spend":
      return result(["spend"], [[round1(416.05 * days)]]);
    case "kpi-cost-per-deploy":
      return result(["cost"], [[47.25]]);
    case "kpi-lines":
      return result(["lines"], [[41_152 * days + 7]]);
    case "kpi-backlog":
      return result(["change"], [[-Math.round(days * 0.6)]]);
    case "kpi-restore":
      return result(["hours"], [[null]]);

    case "bd-incidents":
      return result(
        ["team", "severity", "incidents"],
        SIX_TEAMS.flatMap((team, t) =>
          SEVERITIES.map((severity, s) => [
            team,
            severity,
            Math.round(((t + 2) * (s + 1) * days) / 30),
          ])
        )
      );
    case "bd-reviews":
      return result(
        ["team", "reviews"],
        SIX_TEAMS.map((team, i) => [
          team,
          Math.round((140 - i * 17) * (days / 30)),
        ])
      );
    case "bd-wait-share":
      return result(
        ["team", "share"],
        SIX_TEAMS.map((team, i) => [team, round1(8 + i * 6.4)])
      );
    case "bd-repositories":
      return result(
        ["repository", "commits"],
        REPOSITORIES.map((name, i) => [
          name,
          Math.round((300 / (i + 1)) * (days / 30)),
        ])
      );
    case "bd-environments":
      return result(
        ["environment", "share"],
        [
          ["production", 41.5],
          ["staging", 30.2],
          ["preview", 18.8],
          ["sandbox", 7.1],
          ["load-test", 2.4],
        ]
      );
    case "bd-services":
      return result(
        ["service", "deploys"],
        SERVICES.map((name, i) => [
          name,
          Math.round((5 + ((i * 7) % 23)) * (days / 30)),
        ])
      );

    case "tr-deploys":
      return result(
        ["bucket", "deploys"],
        span.map((day, i) => [day, wave(i)])
      );
    case "tr-lead-time":
      return result(
        ["bucket", "hours"],
        span.map((day, i) => [
          day,
          round1(18 + 6 * Math.cos(i / 5) + (i % 3) * 0.7),
        ])
      );
    case "tr-success":
      return result(
        ["bucket", "success"],
        span.map((day, i) => [day, round1(92 + 6 * Math.sin(i / 4))])
      );
    case "tr-merged":
      return result(
        ["bucket", "merged"],
        span.map((day, i) => [day, 3 + ((i * 5) % 9)])
      );
    case "tr-queue":
      return result(
        ["bucket", "queued"],
        span.map((day, i) => [day, i % 10 < 2 ? null : 10 + ((i * 3) % 14)])
      );

    case "pr-all-runs":
      return result(
        [
          "run_id",
          "pipeline",
          "branch",
          "commit",
          "author",
          "started_at",
          "duration_min",
          "queue_min",
          "stages",
          "retries",
          "outcome",
          "success_rate",
        ],
        Array.from({ length: 650 }, (_, i) => pipelineRun(i))
      );
    case "pr-slow-stages":
      return result(
        ["stage", "pipeline", "p50_min", "p95_min", "share"],
        [
          "compile",
          "test-shard-1",
          "test-shard-2",
          "browser-tests",
          "package",
          "scan",
          "upload",
          "migrate",
          "smoke",
        ].map((stage, i) => [
          stage,
          PIPELINES[i % PIPELINES.length],
          round1(12 - i * 1.1),
          round1(30 - i * 2.4),
          round1(24.333 - i * 2.5),
        ])
      );
    case "pr-runs-per-week":
      return result(
        ["week", "runs"],
        Array.from({ length: 13 }, (_, i) => [
          `2026-W${String(27 + i)}`,
          180 + ((i * 29) % 70),
        ])
      );

    case "edge-long-title":
      return result(
        ["bucket", "deploys"],
        buckets(days, 30).map((day, i) => [day, wave(i) % 4])
      );
    case "edge-long-label":
      return result(["approvals"], [[Math.round(days * 1.4)]]);
    case "edge-empty-line":
      return result(["bucket", "rollbacks"], []);
    case "edge-empty-table":
      return result(["incident", "opened", "severity"], []);
    case "edge-failed":
      return {
        status: 500,
        body: { detail: "The warehouse query timed out." },
      };
    case "edge-busy":
      return { status: 429, body: { detail: "Too many runs at once." } };
    case "edge-missing-column":
      return result(
        ["cause", "total"],
        [
          ["config", 4],
          ["dependency", 3],
          ["capacity", 2],
        ]
      );
    default:
      return undefined;
  }
}
