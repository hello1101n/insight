import { describe, expect, it } from "vitest";

import type {
  AccountOperation,
  BindingHistoryEntry,
} from "@/api/identity-client";
import { accountTrail } from "./trail";

const ANN = "01900000-0000-7000-8000-0000000000a0";
const BOB = "01900000-0000-7000-8000-0000000000b0";
const OPERATOR = "01900000-0000-7000-8000-0000000000f0";
const AUTOMATION = "00000000-0000-0000-0000-000000000000";

function seen(
  at: string,
  person: string,
  over: Partial<BindingHistoryEntry> = {},
): BindingHistoryEntry {
  return {
    person_id: person,
    author_person_id: AUTOMATION,
    by_operator: false,
    reason: "",
    recorded_at: at,
    ...over,
  };
}

function decided(
  at: string,
  person: string,
  reason: string,
  over: Partial<BindingHistoryEntry> = {},
): BindingHistoryEntry {
  return seen(at, person, {
    author_person_id: OPERATOR,
    by_operator: true,
    reason,
    ...over,
  });
}

function call(
  at: string,
  verb: string,
  over: Partial<AccountOperation> = {},
): AccountOperation {
  return {
    operation_id: `op-${at}`,
    verb,
    author_person_id: OPERATOR,
    accounts_touched: 1,
    recorded_at: at,
    ...over,
  };
}

const persons = (rows: ReturnType<typeof accountTrail>) =>
  rows.map((row) => row.entry.person_id);

describe("accountTrail", () => {
  it("keeps nothing for an account with no journal", () => {
    expect(accountTrail([], [])).toEqual([]);
  });

  it("collapses a binding re-observed by every sync into the one that made it", () => {
    const trail = accountTrail(
      [
        seen("2026-08-03T00:00:00.000000", ANN),
        seen("2026-08-02T00:00:00.000000", ANN),
        seen("2026-08-01T00:00:00.000000", ANN),
      ],
      [],
    );

    expect(trail).toHaveLength(1);
    expect(trail[0].entry.recorded_at).toBe("2026-08-01T00:00:00.000000");
  });

  it("keeps every row where the account changed hands", () => {
    const trail = accountTrail(
      [
        seen("2026-08-04T00:00:00.000000", BOB),
        seen("2026-08-03T00:00:00.000000", BOB),
        seen("2026-08-02T00:00:00.000000", ANN),
        seen("2026-08-01T00:00:00.000000", ANN),
      ],
      [],
    );

    expect(persons(trail)).toEqual([BOB, ANN]);
  });

  it("does not resurrect a duplicate after an operator row", () => {
    const trail = accountTrail(
      [
        seen("2026-08-04T00:00:00.000000", ANN),
        decided("2026-08-03T00:00:00.000000", ANN, "operator-bind"),
        seen("2026-08-02T00:00:00.000000", ANN),
      ],
      [],
    );

    expect(trail).toHaveLength(2);
    expect(trail[0].entry.by_operator).toBe(true);
  });

  it("keeps an operator row that moved nobody", () => {
    const trail = accountTrail(
      [
        decided("2026-08-02T00:00:00.000000", ANN, "operator-bind"),
        seen("2026-08-01T00:00:00.000000", ANN),
      ],
      [],
    );

    expect(trail).toHaveLength(2);
    expect(persons(trail)).toEqual([ANN, ANN]);
  });

  it("reads newest first", () => {
    const trail = accountTrail(
      [
        seen("2026-08-02T00:00:00.000000", BOB),
        seen("2026-08-01T00:00:00.000000", ANN),
      ],
      [],
    );

    expect(persons(trail)).toEqual([BOB, ANN]);
  });

  it("never renders a call as a row of its own", () => {
    const trail = accountTrail(
      [decided("2026-08-01T00:00:00.000000", ANN, "operator-bind")],
      [
        call("2026-08-01T00:00:01.000000", "operator-bind", {
          comment: "Same person.",
          accounts_touched: 110,
        }),
      ],
    );

    expect(trail).toHaveLength(1);
    expect(trail[0].comment).toBe("Same person.");
  });

  it("drops a call that produced no movement here", () => {
    const trail = accountTrail(
      [],
      [
        call("2026-08-01T00:00:00.000000", "operator-merge", {
          comment: "Merging the other one.",
          accounts_touched: 30,
          outcome: "already_decided",
        }),
      ],
    );

    expect(trail).toEqual([]);
  });

  it("carries each comment to its own decision when the calls line up", () => {
    const trail = accountTrail(
      [
        decided("2026-08-02T00:00:00.000000", BOB, "operator-bind"),
        decided("2026-08-01T00:00:00.000000", ANN, "operator-bind"),
      ],
      [
        call("2026-08-02T00:00:01.000000", "operator-bind", { comment: "second" }),
        call("2026-08-01T00:00:01.000000", "operator-bind", { comment: "first" }),
      ],
    );

    expect(trail.map((row) => row.comment)).toEqual(["second", "first"]);
  });

  it("attributes nothing when the counts disagree", () => {
    const trail = accountTrail(
      [
        decided("2026-08-02T00:00:00.000000", BOB, "operator-bind"),
        decided("2026-08-01T00:00:00.000000", ANN, "operator-bind"),
      ],
      [call("2026-08-02T00:00:01.000000", "operator-bind", { comment: "which?" })],
    );

    expect(trail.map((row) => row.comment)).toEqual([undefined, undefined]);
  });

  it("keeps the verbs and the authors apart", () => {
    const trail = accountTrail(
      [
        decided("2026-08-02T00:00:00.000000", BOB, "operator-detach"),
        decided("2026-08-01T00:00:00.000000", ANN, "operator-bind", {
          author_person_id: "01900000-0000-7000-8000-0000000000f1",
        }),
      ],
      [
        call("2026-08-02T00:00:01.000000", "operator-detach", { comment: "not theirs" }),
        call("2026-08-01T00:00:01.000000", "operator-bind", { comment: "somebody else's call" }),
      ],
    );

    expect(trail[0].comment).toBe("not theirs");
    expect(trail[1].comment).toBeUndefined();
  });

  it("treats a blank comment as no comment", () => {
    const trail = accountTrail(
      [decided("2026-08-01T00:00:00.000000", ANN, "operator-bind")],
      [call("2026-08-01T00:00:01.000000", "operator-bind", { comment: "   " })],
    );

    expect(trail[0].comment).toBeUndefined();
  });

  it("carries no comment to an automatic row", () => {
    const trail = accountTrail(
      [seen("2026-08-01T00:00:00.000000", ANN, { reason: "auto-seed-link" })],
      [
        {
          operation_id: "op-1",
          verb: "auto-seed-link",
          author_person_id: AUTOMATION,
          accounts_touched: 1,
          comment: "should not appear",
          recorded_at: "2026-08-01T00:00:01.000000",
        },
      ],
    );

    expect(trail[0].comment).toBeUndefined();
  });

  it("survives a read that carries no operations array at all", () => {
    const trail = accountTrail(
      [decided("2026-08-01T00:00:00.000000", ANN, "operator-bind")],
      undefined,
    );

    expect(trail).toHaveLength(1);
    expect(trail[0].comment).toBeUndefined();
  });
});
