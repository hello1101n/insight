import type { DashboardRequest, ServedAnswer, ServedFile } from '../contract';
import { RequestFailure, type DashboardHost } from '../runtime/host';
import { composeServedFile, loadWidgetParts, withWidgetParts } from '../runtime/served';
import catalog from '../../served/catalog.gts.json';
import demo from '../../served/demo-dashboards.gts.json';

/*
 * A host that answers the dashboard root without a backend: the served file
 * is the catalog plus the demo dashboards, and every data request is answered
 * from the fixtures below after a delay, as a product API would. A product
 * replaces it with its own `DashboardHost` (or `fetchHost` over its API); the
 * dashboards and widgets do not change.
 *
 * The numbers are the daily totals of an engineering organisation of about
 * 140 people over 31 days, Monday 2026-10-05 to Wednesday 2026-11-04.
 */

const DAYS = Array.from({ length: 31 }, (_, index) => new Date(Date.UTC(2026, 9, 5 + index)).toISOString().slice(0, 10));
const COMMITS = [54, 51, 57, 132, 78, 3, 11, 44, 64, 74, 58, 33, 30, 7, 62, 53, 42, 45, 48, 6, 6, 50, 93, 98, 76, 56, 11, 4, 43, 60, 83];
const PRS_MERGED = [31, 25, 27, 27, 24, 2, 0, 9, 23, 16, 22, 12, 6, 2, 11, 20, 17, 18, 22, 6, 7, 31, 22, 28, 40, 29, 3, 5, 20, 13, 34];
const PRS_OPENED = [30, 32, 40, 68, 27, 2, 4, 40, 42, 43, 27, 18, 5, 5, 21, 37, 27, 20, 31, 5, 6, 25, 34, 30, 46, 29, 4, 8, 28, 34, 50];
const DEPLOYS = [10, 6, 10, 8, 8, 1, 0, 8, 8, 7, 10, 4, 3, 1, 10, 3, 1, 6, 10, 3, 20, 20, 27, 36, 33, 21, 0, 0, 35, 32, 42];
// The deploys that caused an incident, in the last 7 days and in the 7 days before: the change failure rate is derived from them.
const FAILED_DEPLOYS = 14;
const PREVIOUS_FAILED_DEPLOYS = 14;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
/**
 * `total` split in whole numbers in proportion to `weights`: each part rounds down and what is left goes one each to the
 * parts with the largest remainders (the first on a tie), so the parts add up to `total` exactly.
 */
const splitWhole = (total: number, weights: number[]) => {
  const shares = weights.map((weight) => (total * weight) / sum(weights));
  const top = new Set(
    shares
      .map((share, index) => ({ index, rest: share - Math.floor(share) }))
      .sort((a, b) => b.rest - a.rest || a.index - b.index)
      .slice(0, total - sum(shares.map(Math.floor)))
      .map(({ index }) => index),
  );
  return shares.map((share, index) => Math.floor(share) + (top.has(index) ? 1 : 0));
};
/** The middle value of the sorted values, or the mean of the middle two for an even count. */
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const REPOS = ['payments-api', 'web-console', 'mobile-app', 'search-service', 'billing-worker', 'auth-gateway', 'data-pipeline', 'design-system', 'notifications', 'analytics-ui', 'infra-terraform', 'docs-site'];
const TEAMS = ['Platform', 'Web', 'Mobile', 'Search', 'Billing', 'Identity', 'Data', 'Design', 'Platform', 'Web', 'Infra', 'Docs'];
/** The review time in hours of each repository: the bubble chart draws it, the summary takes the median of it. */
const REVIEW_H = REPOS.map((_, index) => 4 + ((index * 37) % 30));
/** The lead time in hours the summary reports and the lead time stages of the waterfall add up to. */
const LEAD_TIME_H = 26.4;
const PEOPLE = ['A. Novak', 'M. Petrova', 'J. Smith', 'L. Garcia', 'K. Ivanov', 'S. Chen', 'D. Kovac', 'R. Silva', 'T. Muller', 'E. Rossi'];
/** The repositories' shares of the work: of each day's commits (with a daily factor) and of each day's opened pull requests. */
const REPO_SHARE = [20, 16, 13, 11, 9, 8, 7, 6, 5, 4, 3, 2];
/** The pull requests each repository opened on each of the 31 days: the day's opened ones split by the shares. */
const REPO_OPENED = PRS_OPENED.map((opened) => splitWhole(opened, REPO_SHARE));

/**
 * The open pull requests of each age in days, 0 to 22, the age counted back from the last day: a pull request of age N
 * was opened N days before it. The younger ones are more often still open; 200 in all, split in whole numbers, and of
 * each age never more than were opened on that day. Each age's count is split over the repositories by what each
 * opened that day, so no repository has more open of an age than it opened on that day.
 */
const OPEN_BY_AGE = splitWhole(
  200,
  Array.from({ length: 23 }, (_, age) => PRS_OPENED[DAYS.length - 1 - age] / (1 + age / 4)),
);
const OPEN = OPEN_BY_AGE.flatMap((count, age) =>
  splitWhole(count, REPO_OPENED[DAYS.length - 1 - age]).flatMap((open, repo) => Array.from({ length: open }, () => ({ age, repo }))),
);

/** One open pull request per row, with an id such as `REQ-1000`: the grid's 200 rows, the ages in a shuffled order. */
const PULL_REQUESTS = Array.from({ length: OPEN.length }, (_, index) => {
  const seed = (index * 7919) % 997;
  // 7919 and 200 have no common factor, so every open pull request of the list is taken once.
  const { age, repo } = OPEN[(index * 7919) % OPEN.length];
  return {
    id: `REQ-${1000 + index}`,
    title: `${['Fix', 'Add', 'Refactor', 'Update', 'Remove'][seed % 5]} ${['retry policy', 'login form', 'export job', 'cache keys', 'chart legend', 'audit log', 'rate limiter'][seed % 7]}`,
    repo: REPOS[repo],
    author: PEOPLE[seed % PEOPLE.length],
    age_days: age,
    changed_lines: 12 + ((seed * 13) % 1800),
    state: ['open', 'review', 'approved', 'blocked'][seed % 4],
    url: `https://example.com/pulls/${1000 + index}`,
  };
});

const TONE_OF_STATE: Partial<Record<string, 'info' | 'warning'>> = { open: 'info', blocked: 'warning' };
/**
 * The newest open pull request of each of the last 12 days that has one, youngest first, as the items the activity
 * feed of the demo takes, so the items span 12 distinct days: of a day's pull requests, the first in the grid order.
 * The time of each is the last daily day counted back by its age, as a bare date (the one date rule of the widgets),
 * the title names the pull request and its repository, the text is the pull request's own title, and the href is the
 * row's link. A tone only where the state means one: open is info, blocked is warning, the other states none.
 */
const RECENT_ITEMS = [...PULL_REQUESTS]
  .sort((a, b) => a.age_days - b.age_days)
  .filter((pull, index, sorted) => index === 0 || sorted[index - 1].age_days !== pull.age_days)
  .slice(0, 12)
  .map((pull) => {
    const tone = TONE_OF_STATE[pull.state];
    return {
      time: new Date(new Date(`${DAYS[DAYS.length - 1]}T00:00:00Z`).getTime() - pull.age_days * 86_400_000).toISOString().slice(0, 10),
      title: `${pull.id} in ${pull.repo}`,
      text: pull.title,
      ...(tone ? { tone } : {}),
      href: pull.url,
    };
  });

/**
 * Commits by weekday and two-hour block of the day, UTC, over the 31 days: the daily commits split in proportion to
 * the block shape times the weekday share, so the cells add up to the daily commits exactly.
 */
const BLOCKS = ['00', '02', '04', '06', '08', '10', '12', '14', '16', '18', '20', '22'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const BY_BLOCK = [15, 23, 18, 102, 214, 296, 298, 247, 167, 73, 60, 19];
const WEEKDAY_SHARE = [1, 1.1, 1.05, 1.15, 0.9, 0.12, 0.08];
const HEATMAP_COUNTS = splitWhole(sum(COMMITS), WEEKDAY_SHARE.flatMap((share) => BY_BLOCK.map((block) => block * share)));

/**
 * Commits per day for the calendar heatmap: Monday 2026-06-08 to Wednesday 2026-11-04, about five months; its last 31
 * days are the daily commits above. Every 47th day from the 20th has no row (nothing reported), so the calendar shows
 * its empty tiles; none of them falls on the 31 days.
 */
const CALENDAR_DAYS = Array.from({ length: 150 }, (_, index) => new Date(Date.UTC(2026, 5, 8 + index)));
const DAILY_FROM = CALENDAR_DAYS.length - DAYS.length;
const CALENDAR_COMMITS = CALENDAR_DAYS.map((date, index) => {
  if (index >= DAILY_FROM) return COMMITS[index - DAILY_FROM];
  return index % 47 === 20 ? null : Math.round((40 + ((index * 37) % 61)) * WEEKDAY_SHARE[(date.getUTCDay() + 6) % 7]);
});
const CALENDAR = CALENDAR_DAYS.flatMap((date, index) => {
  const commits = CALENDAR_COMMITS[index];
  return commits === null ? [] : [{ day: date.toISOString().slice(0, 10), commits }];
});

/**
 * The commits of each calendar day split over the repositories in whole numbers that add up to the day's commits: each
 * repository's share times a factor that changes from day to day, so the repositories' lines differ. infra-terraform
 * reports no count on Wednesday 2026-10-28 (a gap in its line), so the other repositories carry that day's commits.
 */
const GAP = { repo: REPOS.indexOf('infra-terraform'), day: CALENDAR_DAYS.findIndex((date) => date.toISOString().startsWith('2026-10-28')) };
const isGap = (repo: number, day: number) => repo === GAP.repo && day === GAP.day;
const REPO_DAILY = REPOS.map(() => [] as (number | null)[]);
CALENDAR_COMMITS.forEach((commits, day) => {
  const counts = splitWhole(commits ?? 0, REPO_SHARE.map((share, repo) => (isGap(repo, day) ? 0 : share * (((repo + day) % 5) + 4))));
  counts.forEach((count, repo) => REPO_DAILY[repo].push(isGap(repo, day) ? null : count));
});

/**
 * The days of a period: the demo host's `period` value goes into the query as `7d`, `30d` or `90d`; any other value,
 * or none, is 30 days. A period of N days is the last N calendar days, Wednesday 2026-11-04 the last.
 */
const PERIOD_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
const daysOf = (query: URLSearchParams) => {
  const period = query.get('period') ?? '';
  return Object.hasOwn(PERIOD_DAYS, period) ? PERIOD_DAYS[period] : 30;
};
/** The commits each repository made in the last `days` days: the sums of its daily split, a gap counting as none. */
const repoCommitsIn = (days: number) => REPOS.map((_, repo) => sum(REPO_DAILY[repo].slice(-days).map((count) => count ?? 0)));
/**
 * The pull requests each repository opened in the last `days` days: the sums of its daily split when the daily series
 * covers them; beyond it (90 days) the 30-day count scaled and split by the shares, as no page shows a longer series.
 */
const repoOpenedIn = (days: number) =>
  days <= DAYS.length
    ? REPOS.map((_, repo) => sum(REPO_OPENED.slice(-days).map((opened) => opened[repo])))
    : splitWhole(Math.round((sum(PRS_OPENED.slice(-30)) * days) / 30), REPO_SHARE);

/**
 * CI runs per calendar day by outcome, in whole numbers that add up to the day's runs: 7.5 runs per commit, none on a
 * day with no commit row, and none on Sunday 2026-11-01, when the runners were down. The per-day chart shows the 31
 * daily days; the outcomes of a period are the sums of its days, so the two agree.
 */
const CI_RUNS = CALENDAR_DAYS.map((date, index) => {
  const day = date.toISOString().slice(0, 10);
  const runs = day === '2026-11-01' ? 0 : Math.round((CALENDAR_COMMITS[index] ?? 0) * 7.5);
  const failed = Math.round(runs * (0.1 - (index % 3) * 0.02));
  const cancelled = Math.round(runs * 0.08);
  const skipped = Math.round(runs * (0.06 + (index % 4) * 0.01));
  return { day, passed: runs - failed - cancelled - skipped, failed, cancelled, skipped };
});
const CI_DAILY = CI_RUNS.slice(-DAYS.length);

/**
 * The state, test coverage (a share, 0 to 1) and daily commits of the last 14 days of each repository, for the grid
 * with badge, progress and sparkline columns. The last repository reports no state; the daily counts are the
 * repositories' split of the daily commits, with its one gap.
 */
const REPO_STATES = ['On track', 'On track', 'At risk', 'On track', 'Blocked', 'On track', 'At risk', 'On track', 'On track', 'At risk', 'On track', null];
const REPO_HEALTH = REPOS.map((repo, index) => ({
  repo,
  state: REPO_STATES[index],
  coverage: (42 + ((index * 37) % 50)) / 100,
  daily: REPO_DAILY[index].slice(-14),
}));

/**
 * Pull requests of the last 30 days from opened to merged. Reviewed and approved split the gap between opened and
 * merged in thirds (rounded), so the stages are whole numbers and never grow.
 */
const FUNNEL = (() => {
  const opened = sum(PRS_OPENED.slice(-30));
  const merged = sum(PRS_MERGED.slice(-30));
  const third = (opened - merged) / 3;
  return { opened, reviewed: merged + Math.round(2 * third), approved: merged + Math.round(third), merged };
})();

/**
 * The stages of the lead time in hours, one change per stage and the total the summary's lead time card shows: the
 * review step is the median review time of the repositories, coding and CI are fixed, and waiting to deploy is the rest.
 * Not period-bound, like the lead time card itself: the stage mix is a fixture, not a query over the period.
 */
const CODING_STAGE_H = 4.1;
const CI_STAGE_H = 3.2;
const REVIEW_STAGE_H = median(REVIEW_H);
// The last stage takes what the others leave of the lead time, so the deltas always add up to the total.
const WAITING_STAGE_H = Number((LEAD_TIME_H - CODING_STAGE_H - REVIEW_STAGE_H - CI_STAGE_H).toFixed(1));
const LEAD_TIME_STEPS = [
  { label: 'Coding', value: CODING_STAGE_H, kind: 'delta' },
  { label: 'Review', value: REVIEW_STAGE_H, kind: 'delta' },
  { label: 'CI', value: CI_STAGE_H, kind: 'delta' },
  { label: 'Waiting to deploy', value: WAITING_STAGE_H, kind: 'delta' },
  { label: 'Lead time', value: LEAD_TIME_H, kind: 'total' },
];

const FIXTURES: Record<string, (body: unknown, query: URLSearchParams) => unknown> = {
  '/api/demo/delivery/daily': () => ({
    daily: DAYS.map((day, index) => ({ day, commits: COMMITS[index], prs_merged: PRS_MERGED[index], prs_opened: PRS_OPENED[index], deploys: DEPLOYS[index] })),
  }),
  '/api/demo/delivery/funnel': () => FUNNEL,
  '/api/demo/delivery/leadtime': () => ({ steps: LEAD_TIME_STEPS }),
  '/api/demo/delivery/summary': () => ({
    commits: { value: sum(COMMITS.slice(-7)), previous: sum(COMMITS.slice(-14, -7)), daily: COMMITS.slice(-14) },
    deploys: { value: sum(DEPLOYS.slice(-7)), previous: sum(DEPLOYS.slice(-14, -7)), daily: DEPLOYS.slice(-14) },
    prs_merged: { value: sum(PRS_MERGED.slice(-7)), previous: sum(PRS_MERGED.slice(-14, -7)) },
    prs_opened: { value: sum(PRS_OPENED.slice(-7)), previous: sum(PRS_OPENED.slice(-14, -7)) },
    // The pull requests open now, and the median age of them: the rows the open pull requests grid shows.
    open_prs: { value: PULL_REQUESTS.length, median_age_days: median(PULL_REQUESTS.map((pull) => pull.age_days)) },
    // The median of the repositories' review times the activity request lists.
    review_h: { value: median(REVIEW_H) },
    lead_time_h: { value: LEAD_TIME_H, previous: 31.9 },
    // The deploys that caused an incident over the deploys, in the last 7 days and in the 7 days before.
    change_failure_rate: {
      value: FAILED_DEPLOYS / sum(DEPLOYS.slice(-7)),
      previous: PREVIOUS_FAILED_DEPLOYS / sum(DEPLOYS.slice(-14, -7)),
      failed_deploys: FAILED_DEPLOYS,
      previous_failed_deploys: PREVIOUS_FAILED_DEPLOYS,
    },
    active_contributors: { value: 118, previous: 121 },
  }),
  '/api/demo/ci/outcomes': (_body, query) => {
    const days = CI_RUNS.slice(-daysOf(query));
    const total = (outcome: 'passed' | 'failed' | 'cancelled' | 'skipped') => sum(days.map((row) => row[outcome]));
    return { passed: total('passed'), failed: total('failed'), cancelled: total('cancelled'), skipped: total('skipped') };
  },
  // The commits of each repository over the period's days, and the pull requests it opened in them.
  '/api/demo/repos/activity': (_body, query) => {
    const days = daysOf(query);
    const prs = repoOpenedIn(days);
    const commits = repoCommitsIn(days);
    return REPOS.map((repo, index) => ({
      repo,
      team: TEAMS[index],
      commits: commits[index],
      prs: prs[index],
      review_h: REVIEW_H[index],
    })).sort((a, b) => b.commits - a.commits);
  },
  '/api/demo/teams/goals': () =>
    ['Platform', 'Web', 'Mobile', 'Search', 'Billing'].map((team, index) => ({ team, deployed: 18 + index * 7, target: 40 + index * 5 })),
  '/api/demo/pulls/open': () => ({ pulls: PULL_REQUESTS }),
  // The newest open pull request of each of the last 12 days as the activity feed takes them, not period-bound: the feed shows things as they stand now.
  '/api/demo/pulls/recent': () => ({ items: RECENT_ITEMS }),
  '/api/demo/repos/health': () => ({ repos: REPO_HEALTH }),
  '/api/demo/commits/heatmap': () => ({
    cells: WEEKDAYS.flatMap((weekday, day) => BLOCKS.map((block, index) => ({ weekday, block: `${block}:00`, count: HEATMAP_COUNTS[day * BLOCKS.length + index] }))),
  }),
  // The commits of the three most active repositories of the period, one point per repository and weekday, in the long
  // format a radar_chart takes: the weekday groups of its daily counts, which add up to its commits in the activity
  // answer above. Each weekday of a period holds a reported day of each of them, so no value is null.
  '/api/demo/commits/weekday': (_body, query) => {
    const days = daysOf(query);
    const commits = repoCommitsIn(days);
    const top = REPOS.map((repo, index) => ({ repo, index, commits: commits[index] }))
      .sort((a, b) => b.commits - a.commits)
      .slice(0, 3);
    const daily = top.map(({ index }) => REPO_DAILY[index].slice(-days));
    return {
      points: WEEKDAYS.flatMap((axis, weekday) =>
        top.map(({ repo }, position) => {
          const ofWeekday = daily[position].filter((_, day) => (CALENDAR_DAYS[CALENDAR_DAYS.length - days + day].getUTCDay() + 6) % 7 === weekday);
          return { axis, series: repo, value: sum(ofWeekday.map((count) => count ?? 0)) };
        }),
      ),
    };
  },
  '/api/demo/commits/calendar': () => ({ days: CALENDAR }),
  // The commits of each repository over the period's days, in the format a treemap_chart takes: the labels and
  // values of the activity answer above, the treemap cell beside it draws.
  '/api/demo/repos/commits': (_body, query) => {
    const commits = repoCommitsIn(daysOf(query));
    return {
      items: REPOS.map((repo, index) => ({ label: repo, value: commits[index], group: null })).sort((a, b) => b.value - a.value),
    };
  },
  '/api/demo/ci/daily': () => ({ daily: CI_DAILY }),
  '/api/demo/broken': () => {
    throw new RequestFailure('the mock API answers 500 for this path');
  },
};

/** The served file of the demo without its widget bundles: the catalog file and the demo dashboards. */
export const DEMO_SERVED_FILE: ServedFile = composeServedFile(catalog as ServedFile, demo as ServedFile);

export const DEMO_DASHBOARD_ID = 'gts.frontx.dashboard.dashboard.dashboard.v1~6a0f3c1e-8b2d-4f47-9e15-3c7a2b9d0e41';

/**
 * The mock host. `widgetList` is the address of the served widget list
 * (`dist/widgets.json` of the widgets package, served next to the bundles):
 * the served file is then `file` (or the files of a list it is) followed by
 * the part of every bundle on that list, each registered on its own, read on each dashboard request, so a bundle published or re-pointed shows
 * on the next page load. `file` replaces the demo file (the catalog file and demo
 * dashboards), for tests and for checks of a broken file. `delayMs` delays
 * every answer like a network would.
 */
export function createMockHost({ delayMs = 300, file = DEMO_SERVED_FILE, widgetList }: { delayMs?: number; file?: unknown; widgetList?: string } = {}): DashboardHost {
  const answer = <T,>(signal: AbortSignal, value: () => T) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          // A fresh copy each time, as a parsed response body would be.
          resolve(structuredClone(value()));
        } catch (error) {
          reject(error);
        }
      }, delayMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new RequestFailure('aborted'));
      });
    });
  return {
    loadFile: async (signal) => {
      const served = await answer(signal, () => file);
      // `file` may be broken on purpose: the root's own check names the problem.
      if (!widgetList) return served as ServedAnswer;
      return withWidgetParts(served, () => loadWidgetParts(widgetList, signal));
    },
    request: (request: DashboardRequest, signal) => {
      const [path, query = ''] = request.path.split('#')[0].split('?');
      const fixture = FIXTURES[path];
      if (!fixture) return Promise.reject(new RequestFailure(`the mock API has no ${request.path}`));
      return answer(signal, () => fixture(request.body, new URLSearchParams(query)));
    },
  };
}
