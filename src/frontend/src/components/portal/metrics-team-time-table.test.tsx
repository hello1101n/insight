import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import { teamTimePeriods } from "@/lib/portal/metrics-team-time";
import { LINES_KEY, withCombinedResults } from "@/lib/portal/metrics-view-combined";

import { MetricsTeamTimeTable } from "./metrics-team-time-table";

const TEAM = ["alex", "jamie"];
const PERIODS = teamTimePeriods("2026-10-15", 2);

type Values = Array<[string, number | null]>;

function metric(
  key: string,
  label: string,
  values: Values,
  over: Partial<NormalizedMetricResult> = {},
): NormalizedMetricResult {
  return {
    metric_key: key,
    label,
    unit: null,
    computation: "sum",
    format: "integer",
    direction: "higher_is_better",
    period: {
      view: "period",
      values: values.map(([entity_id, value]) => ({ entity_id, value })),
    },
    ...over,
  } as NormalizedMetricResult;
}

interface Row {
  key: string;
  label: string;
  after: Values;
  before: Values;
  over?: Partial<NormalizedMetricResult>;
}

function renderTable(rows: readonly Row[]) {
  const byKey = (side: "after" | "before") =>
    new Map(rows.map((row) => [row.key, metric(row.key, row.label, row[side], row.over)]));

  render(
    <MetricsTeamTimeTable
      keys={rows.map((row) => row.key)}
      after={byKey("after")}
      before={byKey("before")}
      memberIds={TEAM}
      periods={PERIODS}
    />,
  );
}

const PRS_MERGED: Row = {
  key: "git.prs_merged",
  label: "PRs merged",
  after: [["alex", 40], ["jamie", 30]],
  before: [["alex", 24], ["jamie", 30]],
  over: { direction: "neutral" },
};

const EMAILS_SENT: Row = {
  key: "collab.emails_sent",
  label: "Emails sent",
  after: [["alex", 300], ["jamie", 71]],
  before: [["alex", 200], ["jamie", 171]],
};

function rowOf(label: string): HTMLElement {
  return within(screen.getByRole("table")).getByRole("row", { name: (name) => name.startsWith(label) });
}

function cellsOf(label: string): string[] {
  return within(rowOf(label))
    .getAllByRole("cell")
    .map((cell) => cell.textContent ?? "");
}

function deltaOf(label: string, text: string): HTMLElement {
  return within(within(rowOf(label)).getAllByRole("cell")[0]!).getByText(text);
}

describe("MetricsTeamTimeTable", () => {
  it("heads the columns Metric, After and Before, each period with its days", () => {
    renderTable([PRS_MERGED]);

    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["Metric", "After · 15–28 Oct", "Before · 1–14 Oct"]);
  });

  it("writes a ranked metric's direction beside its label, and a neutral metric's computation small and muted", () => {
    renderTable([
      PRS_MERGED,
      EMAILS_SENT,
      {
        key: "git.pr_cycle_time_h",
        label: "PR cycle time",
        after: [],
        before: [],
        over: { computation: "median", direction: "lower_is_better", unit: "h", format: "decimal" },
      },
    ]);

    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual([
      "PRs merged · Total",
      "Emails sent · Higher is better",
      "PR cycle time · Median · Lower is better",
    ]);
    expect(within(rowOf("PRs merged")).getByText("· Total")).toHaveClass(
      "text-xs",
      "text-muted-foreground",
    );
    expect(within(rowOf("Emails sent")).getByText("· Higher is better")).not.toHaveClass(
      "text-muted-foreground",
    );
  });

  it("sums the team's values in each period and writes the change after the After value", () => {
    renderTable([PRS_MERGED]);

    expect(cellsOf("PRs merged")).toEqual(["70 +16", "54"]);
  });

  it("colours a change green when it is better, red when it is worse, and mutes it for a neutral metric", () => {
    renderTable([
      PRS_MERGED,
      {
        key: "tasks.reopened",
        label: "Tasks reopened",
        after: [["alex", 3]],
        before: [["alex", 5]],
        over: { direction: "lower_is_better" },
      },
      {
        key: "git.reviews_given",
        label: "Reviews given",
        after: [["alex", 10]],
        before: [["alex", 14]],
      },
    ]);

    expect(deltaOf("Tasks reopened", "−2")).toHaveClass("text-success");
    expect(deltaOf("Reviews given", "−4")).toHaveClass("text-destructive");
    expect(deltaOf("PRs merged", "+16")).toHaveClass("text-muted-foreground");
  });

  it("writes a muted 0 when both periods show the same value", () => {
    renderTable([EMAILS_SENT]);

    expect(cellsOf("Emails sent")).toEqual(["371 0", "371"]);
    expect(deltaOf("Emails sent", "0")).toHaveClass("text-muted-foreground");
  });

  it.each(["ratio", "median", "percentile", "stddev", "distinct_count"] as const)(
    "shows no team value and no change for a %s metric",
    (computation) => {
      renderTable([{ ...EMAILS_SENT, over: { computation } }]);

      expect(cellsOf("Emails sent")).toEqual(["—", "—"]);
    },
  );

  it("shows no value when nobody in the team has one, and then no change", () => {
    renderTable([{ ...EMAILS_SENT, before: [["alex", null], ["someone-else", 9]] }]);

    expect(cellsOf("Emails sent")).toEqual(["371", "—"]);
  });

  it("writes hours on a clock and keeps a metric's unit", () => {
    renderTable([
      {
        key: "collab.meeting_hours",
        label: "Meeting hours",
        after: [["alex", 1.5], ["jamie", 0.5833]],
        before: [["alex", 10]],
        over: { unit: "h", format: "decimal", direction: "neutral" },
      },
      {
        key: "collab.active_days",
        label: "Active person-days",
        after: [["alex", 43]],
        before: [["alex", 42]],
        over: { unit: "person-days", direction: "neutral" },
      },
    ]);

    expect(cellsOf("Meeting hours")).toEqual(["2 h 05 min −7 h 55 min", "10 h"]);
    expect(cellsOf("Active person-days")).toEqual(["43 person-days +1 person-days", "42 person-days"]);
  });

  it("sums the team's lines added and removed apart in the Lines row, in KLOC, with no change", () => {
    const lines = (added: Values, removed: Values) =>
      withCombinedResults(
        new Map([
          [
            "git.default_branch_lines_added",
            metric("git.default_branch_lines_added", "Lines added", added, { unit: "lines" }),
          ],
          [
            "git.default_branch_lines_removed",
            metric("git.default_branch_lines_removed", "Lines removed", removed, { unit: "lines" }),
          ],
        ]),
      );

    render(
      <MetricsTeamTimeTable
        keys={[LINES_KEY]}
        after={lines([["alex", 1500], ["jamie", 900]], [["alex", 200], ["jamie", null]])}
        before={lines([["alex", 300]], [["alex", null]])}
        memberIds={TEAM}
        periods={PERIODS}
      />,
    );

    expect(screen.getByRole("rowheader")).toHaveTextContent("Lines · Total");
    expect(cellsOf("Lines")).toEqual(["+2.4 / −0.2 KLOC", "+0.3 / — KLOC"]);
  });
});
