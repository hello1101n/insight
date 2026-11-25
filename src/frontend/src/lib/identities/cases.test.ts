import { describe, expect, it } from "vitest";

import type { AttentionItem, PersonSummary } from "@/api/identity-client";

import {
  detachOffered,
  dropDecided,
  groupIntoCases,
  holderCard,
} from "./cases";

const ANN = { person_id: "01900000-0000-7000-8000-0000000000a0", display_name: "Ann Lee" };
const BOB = { person_id: "01900000-0000-7000-8000-0000000000b0", display_name: "Bob Park" };

function item(over: Partial<AttentionItem>): AttentionItem {
  return {
    kind: "binding_conflict",
    source: "github",
    source_id: "01900000-0000-7000-8000-00000000aa01",
    account_id: "a1",
    email: "dev@example.com",
    username: null,
    candidates: [ANN, BOB],
    ...over,
  };
}

describe("groupIntoCases", () => {
  it("collects every account arguing over the same people into one case", () => {
    const cases = groupIntoCases([
      item({ account_id: "a1", source: "github" }),
      item({ account_id: "a2", source: "gitlab" }),
      item({ account_id: "a3", source: "hr" }),
    ]);

    expect(cases).toHaveLength(1);
    expect(cases[0]?.items).toHaveLength(3);
    expect(cases[0]?.candidates).toEqual([ANN, BOB]);
  });

  it("is blind to the order the candidates arrive in", () => {
    const cases = groupIntoCases([
      item({ account_id: "a1", candidates: [ANN, BOB] }),
      item({ account_id: "a2", candidates: [BOB, ANN] }),
    ]);

    expect(cases).toHaveLength(1);
  });

  it("keeps separate arguments apart", () => {
    const cases = groupIntoCases([
      item({ account_id: "a1", candidates: [ANN, BOB] }),
      item({ account_id: "a2", candidates: [ANN] }),
    ]);

    expect(cases).toHaveLength(2);
  });

  it("leaves candidate-less accounts as cases of their own", () => {
    const cases = groupIntoCases([
      item({ account_id: "a1", kind: "no_evidence", candidates: [] }),
      item({ account_id: "a2", kind: "no_evidence", candidates: [] }),
    ]);

    expect(cases).toHaveLength(2);
  });
});

describe("dropDecided", () => {
  const ref = { source: "github", source_id: "01900000-0000-7000-8000-00000000aa01" };

  it("removes the accounts the server reported as decided", () => {
    const items = [item({ account_id: "a1" }), item({ account_id: "a2" })];

    const left = dropDecided(items, [
      { ...ref, account_id: "a1", outcome: "applied" },
    ]);

    expect(left.map((i) => i.account_id)).toEqual(["a2"]);
  });

  it("treats an already-decided account as decided too", () => {
    const items = [item({ account_id: "a1" })];

    expect(
      dropDecided(items, [{ ...ref, account_id: "a1", outcome: "already_decided" }]),
    ).toHaveLength(0);
  });

  it("keeps a refused account in the queue", () => {
    const items = [item({ account_id: "a1" })];

    expect(
      dropDecided(items, [{ ...ref, account_id: "a1", outcome: "refused" }]),
    ).toHaveLength(1);
  });

  it("matches on the whole account triple, not the id alone", () => {
    const items = [item({ account_id: "a1", source: "gitlab" })];

    expect(
      dropDecided(items, [{ ...ref, account_id: "a1", outcome: "applied" }]),
    ).toHaveLength(1);
  });
});

describe("holderCard", () => {
  it.each<{
    rule: string;
    boundId: string | null;
    holder: PersonSummary | null;
    candidates: PersonSummary[];
    expected: PersonSummary | null;
  }>([
    {
      rule: "the holder card names the binding it matches",
      boundId: ANN.person_id,
      holder: ANN,
      candidates: [],
      expected: ANN,
    },
    {
      rule: "a holder card for a different id than the binding is not the holder",
      boundId: BOB.person_id,
      holder: ANN,
      candidates: [ANN, BOB],
      expected: BOB,
    },
    {
      rule: "a bound candidate names the holder when no card is handed in",
      boundId: BOB.person_id,
      holder: null,
      candidates: [ANN, BOB],
      expected: BOB,
    },
    {
      rule: "an unbound account has no holder, whatever card is handed in",
      boundId: null,
      holder: ANN,
      candidates: [ANN],
      expected: null,
    },
  ])("$rule", ({ boundId, holder, candidates, expected }) => {
    expect(holderCard(boundId, holder, candidates)).toEqual(expected);
  });
});

describe("detachOffered", () => {
  it.each<{
    rule: string;
    holderId: string | null;
    count: number | undefined;
    expected: boolean;
  }>([
    {
      rule: "an account nobody holds can be detached before its count is read",
      holderId: null,
      count: undefined,
      expected: true,
    },
    {
      rule: "an account nobody holds can be detached whatever the count says",
      holderId: null,
      count: 1,
      expected: true,
    },
    {
      rule: "a held account is not detached while the holder's count is unread",
      holderId: ANN.person_id,
      count: undefined,
      expected: false,
    },
    {
      rule: "a holder's only account is not detached",
      holderId: ANN.person_id,
      count: 1,
      expected: false,
    },
    {
      rule: "one of a holder's several accounts can be detached",
      holderId: ANN.person_id,
      count: 2,
      expected: true,
    },
  ])("$rule", ({ holderId, count, expected }) => {
    expect(detachOffered(holderId, count)).toBe(expected);
  });
});
