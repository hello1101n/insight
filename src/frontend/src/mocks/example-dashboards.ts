import type {
  Dashboard,
  DashboardWidget,
  MetricResult,
} from "@/api/custom-client";

// INVARIANT: every number here is synthetic. Each answer grows with the window, so a range change shows.

export interface ExampleDashboard {
  name: string;
  body: Dashboard;
}

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
const TEST_CASES = [
  "checkout applies a discount code to a cart with mixed currencies",
  "search returns results for a query with diacritics in the title",
  "profile page saves the avatar after a slow upload",
  "invoice export writes every line of a multi-page invoice",
  "login keeps the session after the token refresh fails once",
  "report builder keeps the filters after a page reload",
  "notifications mark a thread as read on the second device",
  "cart merges items after a guest signs in",
  "admin can revoke a role while the user is online",
  "calendar shows events that cross the daylight saving change",
  "upload resumes after the network drops at ninety percent",
  "dashboard keeps the period after the browser goes back",
];
const AUTHORS = [
  "Avery Lee",
  "Blake Kim",
  "Casey Moreno",
  "Devon Patel",
  "Emery Novak",
  "Finley Ortiz",
  "Gray Tanaka",
  "Harper Ivanova",
  "Indigo Silva",
  "Jordan Okafor",
];
const TICKET_CATEGORIES = [
  "billing",
  "sign-in",
  "performance",
  "data export",
  "notifications",
  "mobile app",
  "other",
];

const widget = (
  id: string,
  name: string,
  body: DashboardWidget["body"],
  extra: Partial<DashboardWidget> = { clock }
): DashboardWidget => ({ id, name, body, ...extra });

export const EXAMPLE_WIDGETS: DashboardWidget[] = [
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

  widget("bd-incidents", "Incidents by team and severity", {
    type: "bar",
    metric: "bd",
    x: "team",
    y: "incidents",
    series: "severity",
    colors: { critical: "danger", major: "warning", minor: "info" },
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

  widget("cs-builds-per-day", "Builds by result per day", {
    type: "bar",
    metric: "cs",
    x: "bucket",
    y: "builds",
    series: "result",
    labels: true,
  }),
  widget(
    "cs-severity-by-repository",
    "Open issues by repository and severity",
    {
      type: "bar",
      metric: "cs",
      x: "repository",
      y: "open",
      series: "severity",
      labels: true,
    }
  ),
  widget(
    "cs-failure-rate",
    "Failure rate per test",
    { type: "bar", metric: "cs", x: "test_case", y: "failure_rate" },
    { clock, percents: ["failure_rate"] }
  ),
  widget("cs-cost-per-day", "Cost per day, USD", {
    type: "bar",
    metric: "cs",
    x: "bucket",
    y: "cost_usd",
    labels: true,
  }),
  widget("cs-signups-per-day", "Sign-ups per day", {
    type: "bar",
    metric: "cs",
    x: "date",
    y: "signups",
  }),
  widget("cs-top-authors", "Merged pull requests per author, top 10", {
    type: "bar",
    metric: "cs",
    x: "author",
    y: "merged",
  }),
  widget(
    "cs-pass-rate",
    "Pass rate per day",
    { type: "line", metric: "cs", x: "bucket", y: "pass_rate" },
    { clock, percents: ["pass_rate"] }
  ),
  widget("cs-ticket-categories", "Support tickets by category", {
    type: "pie",
    metric: "cs",
    label: "category",
    value: "tickets",
  }),

  widget("ct-deploys", "Deploys", {
    type: "stat",
    metric: "ct",
    value: "deploys",
    label: "deploys in the window",
    compare: {},
  }),
  widget(
    "ct-failure-rate",
    "Change failure rate",
    {
      type: "stat",
      metric: "ct",
      value: "rate",
      label: "of deploys failed",
      compare: { better: "lower" },
    },
    { clock, percents: ["rate"] }
  ),
  widget(
    "ct-lead-time",
    "Lead time",
    {
      type: "stat",
      metric: "ct",
      value: "lead_hours",
      label: "median, commit to deploy",
      compare: { better: "lower" },
    },
    { clock, units: { lead_hours: "h" } }
  ),
  widget("ct-reviews", "Reviews", {
    type: "stat",
    metric: "ct",
    value: "reviews",
    label: "reviews in the window",
    compare: { better: "neutral" },
  }),
  widget("ct-services", "Deploys by service", {
    type: "bar",
    metric: "ct",
    x: "service",
    y: "deploys",
    horizontal: true,
    labels: true,
  }),
  widget("ct-severity-share", "Share of incidents by severity", {
    type: "bar",
    metric: "ct",
    x: "team",
    y: "incidents",
    series: "severity",
    stack: "percent",
    target: { value: 25, label: "Critical limit" },
  }),
  widget(
    "ct-pass-rate",
    "Pass rate per day",
    {
      type: "line",
      metric: "ct",
      x: "bucket",
      y: "pass_rate",
      target: { value: 90, label: "Goal" },
    },
    { clock, percents: ["pass_rate"] }
  ),
  widget("ct-cost", "Cost per day, USD", {
    type: "bar",
    metric: "ct",
    x: "bucket",
    y: "cost_usd",
    target: { value: 20, label: "Budget" },
  }),
  widget("ct-open", "Open pull requests", {
    type: "area",
    metric: "ct",
    x: "bucket",
    y: "open",
    target: { value: 25 },
  }),
  widget(
    "ct-review-wait",
    "Review wait by team",
    {
      type: "bar",
      metric: "ct",
      x: "team",
      y: "wait_hours",
      horizontal: true,
      target: { value: 24, label: "SLA" },
    },
    { clock, units: { wait_hours: "h" } }
  ),
  widget("ct-deploys-by-team", "Deploys per day by team", {
    type: "line",
    metric: "ct",
    x: "bucket",
    y: "deploys",
    series: "team",
  }),
  widget("ct-open-by-team", "Open pull requests by team", {
    type: "area",
    metric: "ct",
    x: "bucket",
    y: "open",
    series: "team",
  }),

  widget("mt-commit-calendar", "Commits per day", {
    type: "heatmap",
    metric: "mt",
    x: "bucket",
    value: "commits",
  }),
  widget("mt-review-hours", "Reviews by weekday and team", {
    type: "heatmap",
    metric: "mt",
    x: "weekday",
    y: "team",
    value: "reviews",
  }),
  widget("mt-review-funnel", "Pull request funnel", {
    type: "funnel",
    metric: "mt",
    stages: ["opened", "reviewed", "approved", "merged"],
  }),
  widget("mt-repositories", "Commits by repository and area", {
    type: "treemap",
    metric: "mt",
    label: "repository",
    value: "commits",
    group: "area",
  }),
  widget("mt-services", "Deploys by service", {
    type: "treemap",
    metric: "mt",
    label: "service",
    value: "deploys",
  }),
  widget(
    "mt-pr-size",
    "Pull request size and review time",
    {
      type: "scatter",
      metric: "mt",
      x: "lines_changed",
      y: "review_hours",
      size: "comments",
      label: "pull_request",
    },
    { clock, units: { review_hours: "h" } }
  ),
  widget(
    "mt-pr-size-by-team",
    "Pull request size and review time by team",
    {
      type: "scatter",
      metric: "mt",
      x: "lines_changed",
      y: "review_hours",
      series: "team",
      label: "pull_request",
    },
    { clock, units: { review_hours: "h" } }
  ),
  widget(
    "mt-stage-timings",
    "Stage timings",
    {
      type: "table",
      metric: "mt",
      columns: ["stage", "p50", "p95", "queued", "runs"],
    },
    { clock, units: { p50: "min", p95: "min", queued: "s" } }
  ),
  widget(
    "mt-lead-by-team",
    "Lead time by team",
    { type: "bar", metric: "mt", x: "team", y: "lead_hours", labels: true },
    { clock, units: { lead_hours: "h" } }
  ),
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
          text: "A bar with a series column stacks. Insight widgets have no grouped bar.",
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
  "chart-shapes": {
    name: "Chart shapes",
    body: {
      title: "Chart shapes",
      time_ranges: ["P7D", "P30D", "PQC"],
      default_range: "P30D",
      items: [
        { widget: "cs-builds-per-day" },
        { widget: "cs-severity-by-repository" },
        { widget: "cs-failure-rate" },
        { widget: "cs-cost-per-day" },
        { widget: "cs-signups-per-day" },
        { widget: "cs-top-authors" },
        { widget: "cs-pass-rate" },
        { widget: "cs-ticket-categories" },
      ],
    },
  },
  "comparisons-and-targets": {
    name: "Comparisons and targets",
    body: {
      title: "Comparisons and targets",
      time_ranges: ["P7D", "P30D", "PQC", "inf"],
      default_range: "P30D",
      items: [
        { heading: "Since the previous period" },
        { widget: "ct-deploys" },
        { widget: "ct-failure-rate" },
        { widget: "ct-lead-time" },
        { widget: "ct-reviews" },
        { heading: "Bars" },
        { widget: "ct-services" },
        { widget: "ct-severity-share" },
        { heading: "Targets" },
        { widget: "ct-pass-rate" },
        { widget: "ct-cost" },
        { widget: "ct-open" },
        { widget: "ct-review-wait" },
        { heading: "By series" },
        { widget: "ct-deploys-by-team" },
        { widget: "ct-open-by-team" },
      ],
    },
  },
  "more-chart-types": {
    name: "More chart types",
    body: {
      title: "More chart types",
      time_ranges: ["P7D", "P30D", "PQC"],
      default_range: "P30D",
      items: [
        { widget: "mt-commit-calendar" },
        { widget: "mt-review-hours" },
        { widget: "mt-review-funnel" },
        { widget: "mt-repositories" },
        { widget: "mt-services" },
        { widget: "mt-pr-size" },
        { widget: "mt-pr-size-by-team" },
        { widget: "mt-stage-timings" },
        { widget: "mt-lead-by-team" },
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

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const AREAS = ["platform", "product", "tooling"];
const STAGES = ["checkout", "build", "unit tests", "browser tests", "deploy"];

// INVARIANT: the bucket grain follows the range as the service picks it: a week over a quarter, a day below.
function weeks(count: number): string[] {
  return Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 6, 6) + i * 7 * 86_400_000)
      .toISOString()
      .slice(0, 10)
  );
}

export function exampleRun(
  id: string,
  range: string | undefined,
  previous = false
): ExampleAnswer | undefined {
  const days = DAYS[range ?? ""] ?? 30;
  const span = buckets(days);
  const total = span.reduce((sum, _, i) => sum + wave(i), 0);
  // INVARIANT: a previous period answers the same shape with other numbers, so a change shows.
  const earlier = previous ? 0.8 : 1;
  const grain = range === "PQC" ? weeks(13) : buckets(days, 31);

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
    case "cs-builds-per-day":
      return result(
        ["bucket", "result", "builds"],
        span.flatMap((day, i) =>
          OUTCOMES.map((outcome, j) => [
            day,
            outcome,
            j === 0 ? wave(i) : (i * (j + 3)) % (j + 4),
          ])
        )
      );
    case "cs-severity-by-repository":
      return result(
        ["repository", "severity", "open"],
        REPOSITORIES.slice(0, 8).flatMap((repository, i) =>
          SEVERITIES.map((severity, j) => [
            repository,
            severity,
            (i * 7 + j * 5) % (j + 6),
          ])
        )
      );
    case "cs-failure-rate":
      return result(
        ["test_case", "failure_rate"],
        TEST_CASES.map((name, i) => [name, round1(48 - i * 3.4)])
      );
    case "cs-cost-per-day":
      return result(
        ["bucket", "cost_usd"],
        // INVARIANT: the warehouse writes a DateTime bucket with its time.
        span.map((day, i) => [
          `${day} 00:00:00`,
          Math.round((8 + wave(i) * 1.7) * 100) / 100,
        ])
      );
    case "cs-signups-per-day":
      return result(
        ["date", "signups"],
        span.map((day, i) => [day, Math.round(40 + wave(i) * 6)])
      );
    case "cs-top-authors":
      return result(
        ["author", "merged"],
        AUTHORS.map((author, i) => [author, Math.round(total / (i + 1.5))])
      );
    case "cs-pass-rate":
      return result(
        ["bucket", "pass_rate"],
        span.map((day, i) => [day, round1(84 + 9 * Math.sin(i / 5))])
      );
    case "cs-ticket-categories":
      return result(
        ["category", "tickets"],
        TICKET_CATEGORIES.map((category, i) => [category, 40 - i * 5])
      );

    case "ct-deploys":
      return result(["deploys"], [[Math.round(total * earlier)]]);
    case "ct-failure-rate":
      return result(["rate"], [[round1((12 + days / 37.5) / earlier)]]);
    case "ct-lead-time":
      return result(["lead_hours"], [[round1((30 + days / 3) * earlier)]]);
    case "ct-reviews":
      return result(["reviews"], [[Math.round(days * 9 * (2 - earlier))]]);
    case "ct-services":
      return result(
        ["service", "deploys"],
        SERVICES.slice(0, 8).map((name, i) => [
          name,
          Math.round((40 - i * 4) * (days / 30)),
        ])
      );
    case "ct-severity-share":
      return result(
        ["team", "severity", "incidents"],
        TEAMS.flatMap((team, t) =>
          SEVERITIES.map((severity, s) => [
            team,
            severity,
            Math.round(((t + 1) * (4 - s) * days) / 15),
          ])
        )
      );
    case "ct-pass-rate":
      return result(
        ["bucket", "pass_rate"],
        span.map((day, i) => [day, round1(88 + 7 * Math.sin(i / 4))])
      );
    case "ct-cost":
      return result(
        ["bucket", "cost_usd"],
        span.map((day, i) => [
          day,
          Math.round((12 + wave(i) * 1.3) * 100) / 100,
        ])
      );
    case "ct-open":
      return result(
        ["bucket", "open"],
        span.map((day, i) => [day, 18 + wave(i * 2)])
      );
    case "ct-review-wait":
      return result(
        ["team", "wait_hours"],
        SIX_TEAMS.map((team, i) => [team, round1(6 + i * 7.5)])
      );
    case "ct-deploys-by-team":
      return result(
        ["bucket", "team", "deploys"],
        buckets(days, 31).flatMap((day, i) =>
          TEAMS.slice(0, 3).map((team, t) => [
            day,
            team,
            // INVARIANT: one team skips some days, so a line by series shows its gaps.
            t === 2 && i % 6 === 0 ? null : wave(i + t * 3),
          ])
        )
      );
    case "ct-open-by-team":
      return result(
        ["bucket", "team", "open"],
        buckets(days, 31).flatMap((day, i) =>
          TEAMS.slice(0, 3).map((team, t) => [day, team, 4 + (wave(i + t) % 7)])
        )
      );

    case "mt-commit-calendar":
      return result(
        ["bucket", "commits"],
        grain.map((day, i) => [
          `${day} 00:00:00`,
          range === "PQC" ? 7 * wave(i) : i % 7 > 4 ? 1 : wave(i),
        ])
      );
    case "mt-review-hours":
      return result(
        ["weekday", "team", "reviews"],
        WEEKDAYS.flatMap((weekday, d) =>
          TEAMS.map((team, t) => [
            weekday,
            team,
            Math.round(((d + 2) * (t + 1) * days) / 20),
          ])
        )
      );
    case "mt-review-funnel":
      return result(
        ["merged", "approved", "reviewed", "opened"],
        [
          [
            Math.round(days * 5.1),
            Math.round(days * 6.2),
            Math.round(days * 8.4),
            Math.round(days * 10),
          ],
        ]
      );
    case "mt-repositories":
      return result(
        ["repository", "area", "commits"],
        REPOSITORIES.map((name, i) => [
          name,
          AREAS[i % AREAS.length],
          Math.round((300 / (i + 1)) * (days / 30)),
        ])
      );
    case "mt-services":
      return result(
        ["service", "deploys"],
        SERVICES.map((name, i) => [
          name,
          Math.round((5 + ((i * 7) % 23)) * (days / 30)),
        ])
      );
    case "mt-pr-size":
    case "mt-pr-size-by-team":
      return result(
        ["pull_request", "team", "lines_changed", "review_hours", "comments"],
        Array.from({ length: 36 }, (_, i) => [
          `PR-${String(4100 + i)}`,
          TEAMS[i % TEAMS.length],
          20 + ((i * 97) % 900),
          round1(1 + ((i * 37) % 60) / 2.5),
          (i * 7) % 15,
        ])
      );
    case "mt-stage-timings":
      return result(
        ["stage", "p50", "p95", "queued", "runs"],
        STAGES.map((stage, i) => [
          stage,
          round1(0.8 + i * 2.6),
          round1(2.5 + i * 9.4),
          45 + i * 140,
          Math.round(days * 40 * (1 - i / 10)),
        ])
      );
    case "mt-lead-by-team":
      return result(
        ["team", "lead_hours"],
        SIX_TEAMS.map((team, i) => [team, round1(14 + i * 9.7)])
      );
    default:
      return undefined;
  }
}
