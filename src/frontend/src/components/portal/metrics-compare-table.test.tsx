vi.mock("@tanstack/react-router", async () => {
  const { portalRouterMock } = await import("@/test/portal-router");
  return portalRouterMock();
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { EvidenceDialogContext } from "@/components/metric-evidence-context";
import type { MembersGridMember } from "@/components/widgets/dashboard/members-grid";
import type { NormalizedMetricResult } from "@/lib/metrics/collection";
import type { PersonTeam } from "@/lib/portal/metrics-view";

import { MetricsCompareTable } from "./metrics-compare-table";

const member = (name: string): MembersGridMember => ({
  entityId: name.toLowerCase().replace(" ", "-"),
  displayName: name,
});

const ALEX = member("Alex Morgan");
const JAMIE = member("Jamie Ellis");
const TAYLOR = member("Taylor Kim");
const CASEY = member("Casey Park");
const SAM = member("Sam Rivera");
const ROBIN = member("Robin Chen");
const SIX = [ALEX, TAYLOR, CASEY, JAMIE, SAM, ROBIN];

const CORE: PersonTeam = { id: "bob", name: "Bob Park" };
const INTEGRATIONS: PersonTeam = { id: "lee", name: "Lee Hart" };

function metric(
  key: string,
  label: string,
  values: ReadonlyArray<[MembersGridMember, number | null]>,
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
      values: values.map(([person, value]) => ({ entity_id: person.entityId, value })),
    },
    ...over,
  } as NormalizedMetricResult;
}

const HOURS = { unit: "h", format: "decimal" } as const;

type Values = ReadonlyArray<ReadonlyArray<number | null>>;

function figmaMetrics(people: readonly MembersGridMember[], columns: Values) {
  const row = (index: number) =>
    people.map((person, column): [MembersGridMember, number | null] => [
      person,
      columns[index]![column] ?? null,
    ]);

  return new Map(
    [
      metric("git.prs_merged", "PRs merged", row(0), { direction: "neutral" }),
      metric("git.pr_cycle_time_h", "PR cycle time", row(1), {
        ...HOURS,
        direction: "lower_is_better",
      }),
      metric("git.pr_merge_rate", "PR merge rate", row(2), {
        format: "percent",
        computation: "ratio",
      }),
      metric("git.commit_size", "Commit size", row(3), {
        unit: "lines",
        computation: "median",
        direction: "lower_is_better",
      }),
      metric("collab.meeting_hours", "Meeting hours", row(4), {
        ...HOURS,
        direction: "neutral",
      }),
      metric("collab.emails_sent", "Emails sent", row(5)),
    ].map((result) => [result.metric_key, result]),
  );
}

const TWO_VALUES: Values = [
  [10, 14],
  [12, 9],
  [90, 80],
  [149, 40],
  [10, 12],
  [40, 0],
];

const SIX_VALUES: Values = [
  [10, 8, 12, 14, 10, 16],
  [12, 15, 12, 9, 9, 15],
  [90, 75, 85, 80, 95, 85],
  [149, 80, 60, 40, 100, 80],
  [10, 8, null, 12, 14, 10],
  [40, 24, 12, 0, 18, 24],
];

function renderTable({
  people,
  values,
  roles = new Map(),
  teams = new Map(),
  openEvidenceTargets = vi.fn(),
}: {
  people: readonly MembersGridMember[];
  values: Values;
  roles?: ReadonlyMap<string, string>;
  teams?: ReadonlyMap<string, PersonTeam>;
  openEvidenceTargets?: () => void;
}) {
  const byKey = figmaMetrics(people, values);
  render(
    <EvidenceDialogContext.Provider
      value={{ openEvidence: vi.fn(), openEvidenceTargets, openEvidencePeople: vi.fn() }}
    >
      <MetricsCompareTable
        people={people}
        keys={[...byKey.keys()]}
        byKey={byKey}
        roles={roles}
        teams={teams}
      />
    </EvidenceDialogContext.Provider>,
  );
}

const table = () => screen.getByRole("table");

function cellsOf(label: string): string[] {
  const row = within(table()).getByRole("row", { name: new RegExp(`^${label}`) });
  return within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent ?? "");
}

function headerRows(): HTMLElement[] {
  return within(table())
    .getAllByRole("row")
    .filter((row) => row.closest("thead"));
}

function personHeaders(): string[] {
  return within(headerRows().at(-1)!)
    .getAllByRole("columnheader")
    .map((header) => header.textContent ?? "");
}

describe("MetricsCompareTable, any number of people", () => {
  it("heads the first column Metric and notes each metric's direction under its label", () => {
    renderTable({ people: [ALEX, JAMIE], values: TWO_VALUES });

    expect(personHeaders()[0]).toBe("Metric");
    expect(
      within(table())
        .getAllByRole("rowheader")
        .map((header) => header.textContent),
    ).toEqual([
      "PRs mergedNeutral",
      "PR cycle timeLower is better",
      "PR merge rateHigher is better",
      "Commit sizeMedian · Lower is better",
      "Meeting hoursNeutral",
      "Emails sentHigher is better",
    ]);
  });

  it("opens that person's records when a value that is not the best is clicked", async () => {
    const openEvidenceTargets = vi.fn();
    const byKey = figmaMetrics([ALEX, JAMIE], TWO_VALUES);
    const emails = byKey.get("collab.emails_sent")!;
    byKey.set("collab.emails_sent", {
      ...emails,
      drilldown: { granularity: ["event"] },
      selection: {
        metric_key: "collab.emails_sent",
        entity: { type: "person", ids: [ALEX.entityId, JAMIE.entityId] },
        period: { from: "2026-07-01", to: "2026-07-31" },
        filters: [],
      },
    } as NormalizedMetricResult);
    render(
      <EvidenceDialogContext.Provider
        value={{ openEvidence: vi.fn(), openEvidenceTargets, openEvidencePeople: vi.fn() }}
      >
        <MetricsCompareTable
          people={[ALEX, JAMIE]}
          keys={["collab.emails_sent"]}
          byKey={byKey}
          roles={new Map()}
          teams={new Map()}
        />
      </EvidenceDialogContext.Provider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Jamie Ellis — Emails sent: 0" }));

    expect(openEvidenceTargets).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          selection: expect.objectContaining({ entity: { type: "person", id: JAMIE.entityId } }),
        }),
      ],
      expect.objectContaining({ title: expect.stringMatching(/^Emails sent · Jamie Ellis · 0 · /) }),
    );
  });
});

describe("MetricsCompareTable, two people", () => {
  it("marks the better value Best and measures the other from it, named after the better person", () => {
    renderTable({ people: [ALEX, JAMIE], values: TWO_VALUES });

    expect(cellsOf("PR cycle time")).toEqual([
      "12 h +3 h vs Jamie",
      "9 h Best",
    ]);
    expect(cellsOf("PR merge rate")).toEqual(["90% Best", "80% −10 pp vs Alex"]);
    expect(cellsOf("Commit size")).toEqual(["149 lines +109 lines vs Jamie", "40 lines Best"]);
    expect(cellsOf("Emails sent")).toEqual(["40 Best", "0 −40 vs Alex"]);
  });

  it("tints the better chip green and the worse chip red", () => {
    renderTable({ people: [ALEX, JAMIE], values: TWO_VALUES });

    const [alex, jamie] = within(within(table()).getByRole("row", { name: /^Emails sent/ }))
      .getAllByRole("cell")
      .map((cell) => cell.firstElementChild!);

    expect(alex).toHaveClass("bg-success/15", "text-success");
    expect(jamie).toHaveClass("bg-destructive/15", "text-destructive");
  });

  it("shows a neutral metric as plain values", () => {
    renderTable({ people: [ALEX, JAMIE], values: TWO_VALUES });

    expect(cellsOf("PRs merged")).toEqual(["10", "14"]);
    expect(cellsOf("Meeting hours")).toEqual(["10 h", "12 h"]);
  });

  it.each([
    ["equal values", [7, 7], ["7", "7"]],
    ["a missing value", [7, null], ["7", "—"]],
  ] as const)("shows %s plain, with no chip", (_case, values, cells) => {
    renderTable({ people: [ALEX, JAMIE], values: TWO_VALUES.map(() => values) });

    expect(cellsOf("Emails sent")).toEqual(cells);
  });

  it("writes each person's role and team under their name", () => {
    renderTable({
      people: [ALEX, JAMIE],
      values: TWO_VALUES,
      roles: new Map([[ALEX.entityId, "Backend engineer"]]),
      teams: new Map([
        [ALEX.entityId, CORE],
        [JAMIE.entityId, INTEGRATIONS],
      ]),
    });

    expect(personHeaders()).toEqual([
      "Metric",
      "Alex MorganBackend engineer · Bob Park's team",
      "Jamie EllisLee Hart's team",
    ]);
  });

  it("writes a team both people share once, above the table, and only the role under each name", () => {
    renderTable({
      people: [ALEX, JAMIE],
      values: TWO_VALUES,
      roles: new Map([[ALEX.entityId, "Backend engineer"]]),
      teams: new Map([
        [ALEX.entityId, CORE],
        [JAMIE.entityId, CORE],
      ]),
    });

    expect(personHeaders()).toEqual(["Metric", "Alex MorganBackend engineer", "Jamie Ellis"]);
    expect(screen.getByText("Bob Park's team")).toBeInTheDocument();
    expect(table()).not.toHaveTextContent("Bob Park's team");
  });

  it("offers the records only through the value, with no link beside it", () => {
    const byKey = figmaMetrics([ALEX, JAMIE], TWO_VALUES);
    const cycle = byKey.get("git.pr_cycle_time_h")!;
    byKey.set("git.pr_cycle_time_h", {
      ...cycle,
      drilldown: { granularity: ["event"] },
      selection: {
        metric_key: "git.pr_cycle_time_h",
        entity: { type: "person", ids: [ALEX.entityId, JAMIE.entityId] },
        period: { from: "2026-07-01", to: "2026-07-31" },
        filters: [],
      },
    } as NormalizedMetricResult);
    render(
      <EvidenceDialogContext.Provider
        value={{ openEvidence: vi.fn(), openEvidenceTargets: vi.fn(), openEvidencePeople: vi.fn() }}
      >
        <MetricsCompareTable
          people={[ALEX, JAMIE]}
          keys={["git.pr_cycle_time_h"]}
          byKey={byKey}
          roles={new Map()}
          teams={new Map()}
        />
      </EvidenceDialogContext.Provider>,
    );

    const row = within(table()).getByRole("row", { name: /^PR cycle time/ });
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["12 h", "9 h"]);
  });
});

describe("MetricsCompareTable, three or more people", () => {
  it("puts the group median first, over the count of people selected", () => {
    renderTable({ people: SIX, values: SIX_VALUES });

    expect(personHeaders().slice(0, 3)).toEqual([
      "Metric",
      "Group median6 selected people",
      "Alex Morgan",
    ]);
    expect(cellsOf("PRs merged")[0]).toBe("11");
  });

  it("measures each value from the group median, and marks the best", () => {
    renderTable({ people: SIX, values: SIX_VALUES });

    expect(cellsOf("Emails sent")).toEqual([
      "21",
      "40 +19 · Best",
      "24 +3",
      "12 −9",
      "0 −21",
      "18 −3",
      "24 +3",
    ]);
    expect(cellsOf("PR merge rate")).toEqual([
      "85%",
      "90% +5 pp",
      "75% −10 pp",
      "85% At median",
      "80% −5 pp",
      "95% +10 pp · Best",
      "85% At median",
    ]);
  });

  it("writes At median beside a value at the median, and Best after it when it is also the best", () => {
    renderTable({ people: [ALEX, TAYLOR, CASEY], values: SIX_VALUES.map(() => [5, 3, 5]) });

    expect(cellsOf("Emails sent")).toEqual([
      "5",
      "5 At median · Best",
      "3 −2",
      "5 At median · Best",
    ]);
  });

  it("tints a value better than the median green and a worse one red", () => {
    renderTable({ people: SIX, values: SIX_VALUES });

    const cells = within(within(table()).getByRole("row", { name: /^Emails sent/ }))
      .getAllByRole("cell")
      .map((cell) => cell.firstElementChild!);

    expect(cells[1]).toHaveClass("bg-success/15");
    expect(cells[3]).toHaveClass("bg-destructive/15");
  });

  it("counts the people with a value beside the median when someone has none", () => {
    renderTable({ people: SIX, values: SIX_VALUES });

    expect(cellsOf("Meeting hours")).toEqual([
      "10 h n = 5",
      "10 h",
      "8 h",
      "—",
      "12 h",
      "14 h",
      "10 h",
    ]);
  });

  it("groups the people under their teams when they come from two or more", () => {
    renderTable({
      people: [ALEX, JAMIE, TAYLOR],
      values: SIX_VALUES,
      roles: new Map([
        [ALEX.entityId, "Backend engineer"],
        [JAMIE.entityId, "Frontend engineer"],
      ]),
      teams: new Map([
        [ALEX.entityId, CORE],
        [JAMIE.entityId, INTEGRATIONS],
        [TAYLOR.entityId, CORE],
      ]),
    });

    const [teamRow] = headerRows();
    expect(within(teamRow!).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["", ""]);
    expect(
      within(teamRow!)
        .getAllByRole("columnheader")
        .map((header) => [header.textContent, (header as HTMLTableCellElement).colSpan]),
    ).toEqual([
      ["Bob Park's team", 2],
      ["Lee Hart's team", 1],
    ]);
    expect(personHeaders()).toEqual([
      "Metric",
      "Group median3 selected people",
      "Alex MorganBackend engineer",
      "Taylor Kim",
      "Jamie EllisFrontend engineer",
    ]);
  });

  it("writes a team everyone shares once, above the table, with no team row", () => {
    renderTable({
      people: [ALEX, JAMIE, TAYLOR],
      values: SIX_VALUES,
      teams: new Map([
        [ALEX.entityId, CORE],
        [JAMIE.entityId, CORE],
        [TAYLOR.entityId, CORE],
      ]),
    });

    expect(screen.getByText("Bob Park's team")).toBeInTheDocument();
    expect(table()).not.toHaveTextContent("Bob Park's team");
    expect(headerRows()).toHaveLength(1);
  });
});
