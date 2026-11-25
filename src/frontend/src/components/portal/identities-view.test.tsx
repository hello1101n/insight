// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import type { AttentionItem, AttentionResponse } from "@/api/identity-client";
import { QUEUE_FIRST_PAGE, QUEUE_MAX_ITEMS } from "@/api/identity-client";

vi.mock("@tanstack/react-router", async () => {
  const { portalRouterMock } = await import("@/test/portal-router");
  return portalRouterMock();
});

const attention = vi.hoisted(() => ({
  limit: 0,
  q: {
    data: undefined as AttentionResponse | undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  },
  merge: { mutateAsync: vi.fn() },
  bulkBind: { mutateAsync: vi.fn(), reset: vi.fn() },
}));
vi.mock("@gears-frontx/ui-kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gears-frontx/ui-kit")>()),
  toast: { add: vi.fn() },
}));
vi.mock("@/queries/identity-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/queries/identity-resolution")>()),
  useAttention: (limit: number) => {
    attention.limit = limit;
    return attention.q;
  },
  useMergePersons: () => attention.merge,
  useBindAccounts: () => attention.bulkBind,
  usePersonAccountsMany: () => ({
    ready: true,
    failed: false,
    accounts: [
      {
        source: "github",
        source_id: "01900000-0000-7000-8000-00000000aa01",
        account_id: "dev-42",
        email: "dev42@example.com",
      },
    ],
    refetch: vi.fn(),
  }),
  useAccountList: () => ({
    data: undefined,
    isFetching: false,
    isFetchingNextPage: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  usePersonList: () => ({
    data: undefined,
    isFetching: false,
    isFetchingNextPage: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  usePersonAccounts: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useAccountBinding: () => ({
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

import { portalRouter } from "@/test/portal-router";

import { IdentitiesView } from "./identities-view";

const RATES = { observed: 60, bound: 55, pending: 3, no_source_id: 1, no_evidence: 1, excluded: 1 };

function item(over: Partial<AttentionItem>): AttentionItem {
  return {
    kind: "contested",
    source: "github",
    source_id: "01900000-0000-7000-8000-00000000aa01",
    account_id: "dev-42",
    email: "dev42@example.com",
    username: null,
    candidates: [],
    ...over,
  };
}

function strip(): string[] {
  const grid = screen.getByText("Accounts").closest("div.grid");
  return [...(grid?.children ?? [])].map((tile) => tile.textContent ?? "");
}

const PRESSES_TO_THE_CEILING = Math.ceil(
  Math.log2(QUEUE_MAX_ITEMS / QUEUE_FIRST_PAGE),
);

async function readToTheCeiling(user: ReturnType<typeof userEvent.setup>) {
  for (let press = 0; press <= PRESSES_TO_THE_CEILING; press += 1) {
    const more = screen.queryByRole("button", { name: /show more cases/i });
    if (!more) return;
    await user.click(more);
  }
  throw new Error(
    `still offering a longer read after ${PRESSES_TO_THE_CEILING + 1} presses, at limit ${attention.limit}`,
  );
}

beforeEach(() => {
  attention.limit = 0;
  attention.q.data = undefined;
  attention.q.isLoading = false;
  attention.q.isError = false;
  attention.q.isFetching = false;
  attention.q.isPlaceholderData = false;
  attention.q.refetch.mockClear();
  portalRouter.reset("/manage/identities");
});

describe("IdentitiesView", () => {
  it("sizes the tenant in one strip: every account, the backlog, the excluded", () => {
    attention.q.data = { items: [item({}), item({ account_id: "a2" })], rates: RATES };
    render(<IdentitiesView />);

    expect(strip()).toEqual(["60Accounts", "2Needs attention", "1Excluded"]);
  });

  it("prints no person total at all", () => {
    attention.q.data = { items: [item({})], rates: RATES };
    render(<IdentitiesView />);

    expect(screen.queryByText(/persons/i)).not.toBeInTheDocument();
  });

  it("keeps the resolver's internal states out of the strip", () => {
    attention.q.data = { items: [item({})], rates: RATES };
    render(<IdentitiesView />);

    expect(screen.queryByText(/bound to a person/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/unbound/i)).not.toBeInTheDocument();
    expect(strip()).toHaveLength(3);
  });

  it("shows the backlog as a floor when the server cut the list", () => {
    attention.q.data = { items: [item({})], rates: RATES, items_truncated: true };
    render(<IdentitiesView />);

    expect(strip()[1]).toBe("1+Needs attention");
  });

  it("celebrates the empty queue instead of rendering a blank table", () => {
    attention.q.data = { items: [], rates: RATES };
    render(<IdentitiesView />);

    expect(screen.getByText(/everything is resolved/i)).toBeInTheDocument();
    expect(screen.getByText("60")).toBeInTheDocument();
  });

  it("answers a shared ?acct= link even after the backlog is worked to zero", () => {
    attention.q.data = { items: [], rates: RATES };
    portalRouter.set({
      acct: "github:01900000-0000-7000-8000-00000000aa01:dev-42",
    });
    render(<IdentitiesView />);

    expect(screen.getByText(/everything is resolved/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("keeps a bare empty queue a plain celebration — no panel, no placeholder", () => {
    attention.q.data = { items: [], rates: RATES };
    render(<IdentitiesView />);

    expect(screen.getByText(/everything is resolved/i)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/pick an account from the queue/i)).not.toBeInTheDocument();
  });

  it("says so when the server truncated the evidence — partial counts must not read as tenant-wide", () => {
    attention.q.data = { items: [], rates: RATES, truncated: true };
    render(<IdentitiesView />);

    expect(screen.getByText(/cover only part of the observed accounts/i)).toBeInTheDocument();
  });

  it("asks for a longer queue when the item cap cut the list", async () => {
    attention.q.data = { items: [item({})], rates: RATES, items_truncated: true };
    const user = userEvent.setup();
    render(<IdentitiesView />);

    expect(attention.limit).toBe(QUEUE_FIRST_PAGE);
    await user.click(screen.getByRole("button", { name: /show more cases/i }));

    expect(attention.limit).toBe(QUEUE_FIRST_PAGE * 2);
    expect(
      screen.queryByText(/only the first accounts needing review/i),
    ).not.toBeInTheDocument();
  });

  it("says it is loading for a longer read and stays put for a background one", () => {
    attention.q.data = { items: [item({})], rates: RATES, items_truncated: true };
    attention.q.isFetching = true;
    attention.q.isPlaceholderData = true;
    const { rerender } = render(<IdentitiesView />);

    expect(screen.getByRole("button", { name: /loading/i })).toBeDisabled();

    attention.q.isPlaceholderData = false;
    rerender(<IdentitiesView />);

    expect(screen.getByRole("button", { name: /show more cases/i })).toBeEnabled();
  });

  it("does not celebrate an empty page while a longer read is on offer", () => {
    attention.q.data = { items: [], rates: RATES, items_truncated: true };
    render(<IdentitiesView />);

    expect(screen.queryByText(/everything is resolved/i)).not.toBeInTheDocument();
    expect(screen.getByText(/only the first accounts needing review/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show more cases/i })).toBeInTheDocument();
  });

  it("offers the way back to the shorter list when the longer read fails", async () => {
    attention.q.data = { items: [item({})], rates: RATES, items_truncated: true };
    const user = userEvent.setup();
    const view = render(<IdentitiesView />);
    await user.click(screen.getByRole("button", { name: /show more cases/i }));
    expect(attention.limit).toBe(QUEUE_FIRST_PAGE * 2);

    attention.q.isError = true;
    attention.q.data = undefined;
    view.rerender(<IdentitiesView />);
    expect(screen.getByText(/the longer read failed/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(attention.limit).toBe(QUEUE_FIRST_PAGE);
    expect(attention.q.refetch).not.toHaveBeenCalled();
  });

  it("offers no longer read when the whole queue is listed", () => {
    attention.q.data = { items: [item({})], rates: RATES };
    render(<IdentitiesView />);

    expect(
      screen.queryByRole("button", { name: /show more cases/i }),
    ).not.toBeInTheDocument();
  });

  it("says the list was cut once the service will answer nothing longer", async () => {
    attention.q.data = { items: [item({})], rates: RATES, items_truncated: true };
    const user = userEvent.setup();
    render(<IdentitiesView />);

    await readToTheCeiling(user);

    expect(attention.limit).toBe(QUEUE_MAX_ITEMS);
    expect(screen.getByText(/only the first accounts needing review/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/cover only part of the observed accounts/i),
    ).not.toBeInTheDocument();
  });

  it("does not repeat the item-cap notice when the evidence read was truncated too", async () => {
    attention.q.data = {
      items: [item({})],
      rates: RATES,
      truncated: true,
      items_truncated: true,
    };
    const user = userEvent.setup();
    render(<IdentitiesView />);

    await readToTheCeiling(user);

    expect(screen.getByText(/cover only part of the observed accounts/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/only the first accounts needing review/i),
    ).not.toBeInTheDocument();
  });

  it("shows no truncation warning on a complete read, including from an older backend", () => {
    attention.q.data = { items: [], rates: RATES };
    render(<IdentitiesView />);

    expect(
      screen.queryByText(/cover only part of the observed accounts/i),
    ).not.toBeInTheDocument();
  });

  it("groups by kind with honest counts, and an unknown kind still shows", () => {
    attention.q.data = {
      items: [
        item({ account_id: "a1" }),
        item({ account_id: "a2" }),
        item({ kind: "no_evidence", account_id: "bot-1", email: null, username: "bot-1" }),
        item({ kind: "quarantined", account_id: "q-1", email: null, username: null }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    const contested = screen.getByRole("button", { name: /contested/i });
    expect(within(contested).getByText("2")).toBeInTheDocument();
    expect(screen.getByText(/no address to match on/i)).toBeInTheDocument();
    expect(screen.getByText("q-1")).toBeInTheDocument();
  });

  it("lists every case of a group at once", () => {
    attention.q.data = {
      items: Array.from({ length: 25 }, (_, n) =>
        item({ account_id: `a${n}`, email: `dev${n}@example.com` }),
      ),
      rates: RATES,
    };
    render(<IdentitiesView />);

    expect(screen.getAllByRole("button", { name: /@example\.com/i })).toHaveLength(25);
    expect(
      screen.queryByRole("button", { name: /show \d+ more cases/i }),
    ).not.toBeInTheDocument();
  });

  it("shows one case for the accounts arguing over the same people", () => {
    const candidates = [
      { person_id: "01900000-0000-7000-8000-0000000000a0", display_name: "Ann Lee" },
      { person_id: "01900000-0000-7000-8000-0000000000b0", display_name: "Bob Park" },
    ];
    attention.q.data = {
      items: [
        item({
          kind: "binding_conflict",
          account_id: "a1",
          source: "hr",
          candidates,
          bound_to: candidates[0]?.person_id,
        }),
        item({
          kind: "binding_conflict",
          account_id: "a2",
          source: "wiki",
          candidates,
          bound_to: candidates[1]?.person_id,
        }),
        item({
          kind: "binding_conflict",
          account_id: "a3",
          source: "chat",
          candidates,
          bound_to: candidates[1]?.person_id,
        }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    expect(screen.getAllByText("Ann Lee")).toHaveLength(1);
    expect(screen.getByText(/1 case · 3 accounts/i)).toBeInTheDocument();
    expect(screen.getByText(/held by Ann Lee/i)).toBeInTheDocument();
    expect(screen.getAllByText(/held by Bob Park/i)).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /dev42@example\.com/i })).toHaveLength(3);
  });

  it("offers a merge on each person of a disputed case, saying which way it goes", () => {
    const candidates = [
      { person_id: "01900000-0000-7000-8000-0000000000a0", display_name: "Ann Lee" },
      { person_id: "01900000-0000-7000-8000-0000000000b0", display_name: "Bob Park" },
    ];
    attention.q.data = {
      items: [item({ kind: "contested", account_id: "a1", candidates })],
      rates: RATES,
    };
    render(<IdentitiesView />);

    expect(
      screen.getAllByRole("button", { name: /merge into this person/i }),
    ).toHaveLength(2);
    expect(
      screen.getAllByText(/everyone else in this case merges into them/i),
    ).toHaveLength(2);
  });

  it("merges the rest into the person whose row was pressed", async () => {
    const ANN = {
      person_id: "01900000-0000-7000-8000-0000000000a0",
      display_name: "Ann Lee",
    };
    const BOB = {
      person_id: "01900000-0000-7000-8000-0000000000b0",
      display_name: "Bob Park",
    };
    attention.merge.mutateAsync.mockResolvedValue({
      applied: 1,
      already_decided: 0,
      items: [
        {
          source: "github",
          source_id: "01900000-0000-7000-8000-00000000aa01",
          account_id: "dev-42",
          outcome: "applied",
        },
      ],
    });
    attention.q.data = {
      items: [item({ kind: "contested", account_id: "a1", candidates: [ANN, BOB] })],
      rates: RATES,
    };
    render(<IdentitiesView />);

    const rows = screen.getAllByRole("button", { name: /merge into this person/i });
    await userEvent.click(rows[0]);

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/merge the rest into ann lee/i),
    ).toBeInTheDocument();

    await userEvent.click(
      within(dialog).getByRole("button", { name: "Merge persons" }),
    );

    expect(attention.merge.mutateAsync).toHaveBeenCalledWith({
      source_person_id: BOB.person_id,
      target_person_id: ANN.person_id,
    });
  });

  it("offers no merge where the case argues over a single person", () => {
    attention.q.data = {
      items: [
        item({
          kind: "provisioned_at_login",
          account_id: "a1",
          candidates: [
            {
              person_id: "01900000-0000-7000-8000-0000000000a0",
              display_name: "Ann Lee",
            },
          ],
        }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    expect(
      screen.queryByRole("button", { name: /merge into this person/i }),
    ).not.toBeInTheDocument();
  });

  it("names an account with nothing to match on by what the source says it is", () => {
    attention.q.data = {
      items: [
        item({
          kind: "no_evidence",
          account_id: "921",
          email: null,
          username: null,
          display_name: "Ann Lee",
          job_title: "Engineer",
          department: "Platform",
          status: "Inactive",
          manager_email: "lead@example.com",
        }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    const row = screen.getByRole("button", { name: /ann lee/i });
    expect(within(row).getByText(/Engineer · Platform/)).toBeInTheDocument();
    expect(within(row).getByText(/reports to lead@example\.com/)).toBeInTheDocument();
    expect(within(row).getByText("Inactive")).toBeInTheDocument();
    expect(within(row).getByText(/github · 921/)).toBeInTheDocument();
  });

  it("keeps a login-minted binding on the queue until a human decides it", () => {
    attention.q.data = {
      items: [
        item({
          kind: "provisioned_at_login",
          account_id: "new-joiner",
          email: null,
          username: "new-joiner",
          bound_to: "01900000-0000-7000-8000-0000000000c0",
          candidates: [
            {
              person_id: "01900000-0000-7000-8000-0000000000c0",
              display_name: "Carol Chen",
            },
          ],
        }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    expect(screen.getByText(/given a person at first sign-in/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new-joiner/i })).toBeInTheDocument();
  });

  it("keeps a roster-minted binding on the queue as its own kind", () => {
    attention.q.data = {
      items: [
        item({
          kind: "minted_from_roster",
          account_id: "874",
          email: null,
          username: null,
          display_name: "Ravi Menon",
          bound_to: "01900000-0000-7000-8000-0000000000d0",
          candidates: [
            {
              person_id: "01900000-0000-7000-8000-0000000000d0",
              display_name: "Ravi Menon",
            },
          ],
        }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    expect(
      screen.getByText(/added from the roster without an address/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs review/i)).not.toBeInTheDocument();
  });

  it("gives an account no source states an id for its own group", () => {
    attention.q.data = {
      items: [
        item({
          kind: "no_source_id",
          account_id: "sam@example.com",
          email: "sam@example.com",
          username: null,
          display_name: "Sam Rivera",
          bound_to: null,
          candidates: [],
        }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    expect(
      screen.getByText(/the source names no account of its own/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/needs review/i)).not.toBeInTheDocument();
  });

  it("renders candidates as person cells", () => {
    attention.q.data = {
      items: [
        item({
          candidates: [
            {
              person_id: "01900000-0000-7000-8000-000000000001",
              display_name: "Bob Park",
              email: "bob.park@example.com",
            },
          ],
        }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    expect(screen.getByText("Bob Park")).toBeInTheDocument();
  });

  it("writes the selection into the URL and toggles it off on a second click", async () => {
    attention.q.data = { items: [item({})], rates: RATES };
    render(<IdentitiesView />);

    const row = screen.getByRole("button", { name: /dev42@example\.com/i });
    await userEvent.click(row);
    expect(portalRouter.search.acct).toContain("dev-42");
    expect(row).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(row);
    expect(portalRouter.search.acct).toBeUndefined();
  });

  it("keeps a copy press inside a row from selecting the case", async () => {
    attention.q.data = {
      items: [
        item({
          candidates: [
            { person_id: "01900000-0000-7000-8000-000000000001", display_name: "Bob Park" },
          ],
        }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    await userEvent.click(
      screen.getByRole("button", { name: /copy 01900000-0000-7000-8000-000000000001/i }),
    );
    expect(portalRouter.search.acct).toBeUndefined();
  });

  it("opens the case in a window, and closing it clears the shared link", async () => {
    attention.q.data = { items: [item({})], rates: RATES };
    render(<IdentitiesView />);

    await userEvent.click(screen.getByRole("button", { name: /dev42@example\.com/i }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/github · dev-42/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(portalRouter.search.acct).toBeUndefined();
  });

  it("answers a shared ?acct= link by opening its case", () => {
    attention.q.data = { items: [item({})], rates: RATES };
    portalRouter.set({
      acct: "github:01900000-0000-7000-8000-00000000aa01:dev-42",
    });
    render(<IdentitiesView />);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("moves between rows with the arrow keys", async () => {
    attention.q.data = {
      items: [
        item({ account_id: "a1", email: "ann@example.com" }),
        item({ account_id: "a2", email: "bob@example.com" }),
      ],
      rates: RATES,
    };
    render(<IdentitiesView />);

    const first = screen.getByRole("button", { name: /ann@example\.com/i });
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /bob@example\.com/i })).toHaveFocus();

    await userEvent.keyboard("{ArrowUp}");
    expect(first).toHaveFocus();
  });

  it("returns focus to the row when the case window closes", async () => {
    attention.q.data = { items: [item({})], rates: RATES };
    render(<IdentitiesView />);

    const row = screen.getByRole("button", { name: /dev42@example\.com/i });
    await userEvent.click(row);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));

    expect(row).toHaveFocus();
  });

  it("keeps the open case when the decided row is pruned", async () => {
    attention.q.data = {
      items: [
        item({ account_id: "a1", email: "ann@example.com" }),
        item({ account_id: "a2", email: "bob@example.com" }),
      ],
      rates: RATES,
    };
    const view = render(<IdentitiesView />);

    await userEvent.click(screen.getByRole("button", { name: /ann@example\.com/i }));
    attention.q.data = {
      items: [item({ account_id: "a2", email: "bob@example.com" })],
      rates: RATES,
    };
    view.rerender(<IdentitiesView />);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/ann@example\.com/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/link may be stale/i)).not.toBeInTheDocument();
  });

  it("switches modes by path, leaving behind what was open in the old one", async () => {
    attention.q.data = { items: [item({})], rates: RATES };
    act(() => portalRouter.set({ acct: "malformed", person: "not-a-person", find: "ann", src: "github" }));
    render(<IdentitiesView />);
    portalRouter.navigations.length = 0;

    await userEvent.click(screen.getByRole("tab", { name: /a person and their accounts/i }));

    expect(portalRouter.navigations).toEqual([
      expect.objectContaining({ to: "/manage/identities/$mode", params: { mode: "person" } }),
    ]);
    expect(portalRouter.search).toEqual({ find: "ann", src: "github" });
  });

  it("opens the mode its path names", () => {
    attention.q.data = { items: [item({})], rates: RATES };
    render(<IdentitiesView mode="person" />);

    expect(
      screen.getByRole("searchbox", { name: /search people/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /dev42@example\.com/i }),
    ).not.toBeInTheDocument();
  });

  it("offers a retry on a failed load", async () => {
    attention.q.isError = true;
    render(<IdentitiesView />);

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(attention.q.refetch).toHaveBeenCalled();
  });
});
