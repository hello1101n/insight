import { describe, expect, it } from "vitest";

import type { CorrectionResponse } from "@/api/identity-client";
import { combineOutcomes, fullyDecided, refusedCount } from "./outcomes";

const ACCOUNT = {
  source: "github",
  source_id: "01900000-0000-7000-8000-00000000aa01",
};

function answer(
  outcomes: string[],
  over: Partial<CorrectionResponse> = {},
): CorrectionResponse {
  return {
    applied: outcomes.filter((o) => o === "applied").length,
    already_decided: outcomes.filter((o) => o === "already_decided").length,
    items: outcomes.map((outcome, index) => ({
      ...ACCOUNT,
      account_id: `acct-${index}`,
      outcome,
    })),
    ...over,
  };
}

describe("combineOutcomes", () => {
  it("adds the counters and concatenates the items", () => {
    const folded = combineOutcomes([
      answer(["applied", "already_decided"]),
      answer(["applied"]),
    ]);

    expect(folded.applied).toBe(2);
    expect(folded.already_decided).toBe(1);
    expect(folded.items).toHaveLength(3);
  });

  it("folds an empty sequence to a zero answer rather than throwing", () => {
    expect(combineOutcomes([])).toEqual({
      applied: 0,
      already_decided: 0,
      items: [],
      new_person_id: undefined,
    });
  });

  it("carries the last minted person id through the fold", () => {
    const folded = combineOutcomes([
      answer(["applied"]),
      answer(["applied"], { new_person_id: "01900000-0000-7000-8000-00000000dead" }),
      answer(["applied"]),
    ]);

    expect(folded.new_person_id).toBe("01900000-0000-7000-8000-00000000dead");
  });
});

describe("fullyDecided", () => {
  const cases: [string, string[], boolean][] = [
    ["everything applied", ["applied", "applied"], true],
    ["everything already decided", ["already_decided"], true],
    ["a mix of the two", ["applied", "already_decided"], true],
    ["one refusal among applied", ["applied", "refused"], false],
    ["nothing but refusals", ["refused"], false],
    ["an outcome this build does not know", ["applied", "ambiguous_value"], false],
    ["no items at all", [], true],
  ];

  for (const [name, outcomes, expected] of cases) {
    it(`${expected ? "accepts" : "rejects"} ${name}`, () => {
      expect(fullyDecided(answer(outcomes))).toBe(expected);
    });
  }
});

describe("refusedCount", () => {
  it("counts only the refusals", () => {
    expect(
      refusedCount(answer(["applied", "refused", "already_decided", "refused"])),
    ).toBe(2);
  });
});
