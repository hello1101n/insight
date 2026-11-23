// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import type { AccountBinding, CorrectionResponse } from "@/api/identity-client";

const hooks = vi.hoisted(() => {
  const verb = () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null as unknown,
  });
  return {
    toast: { add: vi.fn() },
    bind: verb(),
    detach: verb(),
    owned: {
      data: undefined as { person_id: string; accounts: unknown[] } | undefined,
    },
    exclude: verb(),
    search: {
      data: undefined as { pages: { items: unknown[] }[] } | undefined,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    },
  };
});
vi.mock("@/hooks/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));
vi.mock("@gears-frontx/ui-kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@gears-frontx/ui-kit")>()),
  toast: hooks.toast,
}));
vi.mock("@/queries/identity-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/queries/identity-resolution")>()),
  useBindAccount: () => hooks.bind,
  useDetachAccount: () => hooks.detach,
  usePersonAccounts: () => hooks.owned,
  useExcludeAccount: () => hooks.exclude,
  usePersonList: () => hooks.search,
}));

import { AccountActions } from "./account-actions";
import { toastsOf } from "@/test/toast";

const REF = {
  source: "github",
  source_id: "01900000-0000-7000-8000-00000000aa01",
  account_id: "dev-42",
};
const BOB = {
  person_id: "01900000-0000-7000-8000-0000000000b0",
  display_name: "Bob Park",
  email: "bob.park@example.com",
};
const CAROL = {
  person_id: "01900000-0000-7000-8000-0000000000c0",
  display_name: "Carol Chen",
  email: "carol.chen@example.com",
};

function binding(over: Partial<AccountBinding> = {}): AccountBinding {
  return { ...REF, person_id: BOB.person_id, history: [], ...over };
}

beforeEach(() => {
  for (const verb of [hooks.bind, hooks.detach, hooks.exclude]) {
    verb.mutate.mockReset();
    verb.reset.mockReset();
    verb.isError = false;
    verb.error = null;
    verb.isPending = false;
  }
  hooks.toast.add.mockClear();
  hooks.owned.data = { person_id: BOB.person_id, accounts: [{}, {}] };
  hooks.search.data = undefined;
});

describe("AccountActions", () => {
  it("labels the bound candidate Confirm and the rival Bind", () => {
    render(
      <AccountActions accountRef={REF} binding={binding()} candidates={[BOB, CAROL]} />,
    );

    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bind" })).toBeInTheDocument();
  });

  it("offers nothing to confirm where the surface sends no candidates", () => {
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[]}
        holder={BOB}
      />,
    );

    expect(screen.queryByRole("button", { name: /^confirm$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/candidates/i)).not.toBeInTheDocument();
  });

  it("keeps the holder out of the person search", async () => {
    hooks.search.data = { pages: [{ items: [BOB, CAROL] }] };
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[]}
        holder={BOB}
      />,
    );

    await userEvent.type(screen.getByRole("searchbox"), "park");

    expect(
      screen.getByRole("button", { name: /carol chen/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /bob park/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the holder out of the search with no card to name them by", async () => {
    hooks.search.data = { pages: [{ items: [BOB, CAROL] }] };
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: CAROL.person_id })}
        candidates={[]}
      />,
    );

    await userEvent.type(screen.getByRole("searchbox"), "park");

    expect(screen.getByRole("button", { name: /bob park/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /carol chen/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps the candidates out of the search that names them already", async () => {
    hooks.search.data = { pages: [{ items: [BOB, CAROL] }] };
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: null })}
        candidates={[CAROL]}
      />,
    );

    await userEvent.type(screen.getByRole("searchbox"), "chen");

    expect(screen.getByText("Carol Chen")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /carol chen/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /bob park/i })).toBeInTheDocument();
  });

  it("offers the person search whatever the account's state", () => {
    const { rerender } = render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: null })}
        candidates={[]}
      />,
    );

    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    expect(screen.getByText(/assign to a person/i)).toBeInTheDocument();

    rerender(
      <AccountActions accountRef={REF} binding={binding()} candidates={[]} />,
    );

    expect(screen.getByRole("searchbox")).toBeInTheDocument();
    expect(screen.getByText(/assign to someone else/i)).toBeInTheDocument();
  });

  it("offers no detach where it would leave the holder with nothing", () => {
    hooks.owned.data = { person_id: BOB.person_id, accounts: [{}] };
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[]}
        holder={BOB}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /detach into a new person/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /exclude \(bot/i })).toBeInTheDocument();
  });

  it("offers a detach once the holder has more than one account", () => {
    hooks.owned.data = { person_id: BOB.person_id, accounts: [{}, {}] };
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[]}
        holder={BOB}
      />,
    );

    expect(
      screen.getByRole("button", { name: /detach into a new person/i }),
    ).toBeInTheDocument();
  });

  it("offers a detach for an account nobody holds, whatever the read says", () => {
    hooks.owned.data = undefined;
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: null })}
        candidates={[]}
      />,
    );

    expect(
      screen.getByRole("button", { name: /detach into a new person/i }),
    ).toBeInTheDocument();
  });

  it("holds the detach back while the holder's accounts are still unread", () => {
    hooks.owned.data = undefined;
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[]}
        holder={BOB}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /detach into a new person/i }),
    ).not.toBeInTheDocument();
  });

  it("names the holder once, with Confirm on their own card", () => {
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[BOB]}
        holder={BOB}
      />,
    );

    expect(screen.getByText(/currently bound to/i)).toBeInTheDocument();
    expect(screen.getAllByText("Bob Park")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
    expect(screen.queryByText(/candidates/i)).not.toBeInTheDocument();
  });

  it("lists only the rivals under candidates, each offering a plain bind", () => {
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[BOB, CAROL]}
        holder={BOB}
      />,
    );

    expect(screen.getByText(/candidates/i)).toBeInTheDocument();
    expect(screen.getAllByText("Carol Chen")).toHaveLength(1);
    expect(screen.getAllByText("Bob Park")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Bind" })).toBeInTheDocument();
  });

  it("offers no Confirm where the account is not up for confirmation", () => {
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[]}
        holder={BOB}
      />,
    );

    expect(screen.getByText(/currently bound to/i)).toBeInTheDocument();
    expect(screen.getByText("Bob Park")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
  });

  it("keeps an unknown holder an honest bare id", () => {
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: "01900000-0000-7000-8000-00000000ffff" })}
        candidates={[]}
      />,
    );

    expect(
      screen.getByText("01900000-0000-7000-8000-00000000ffff"),
    ).toBeInTheDocument();
  });

  it("states an unbound account as a fact", () => {
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: null })}
        candidates={[]}
      />,
    );

    expect(screen.getByText(/account is unresolved/i)).toBeInTheDocument();
  });

  it("never offers a merge, however many candidates there are", () => {
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[BOB, CAROL]}
      />,
    );

    expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();
  });

  it("bind goes through a confirmation and sends the WIRE account shape", async () => {
    render(
      <AccountActions accountRef={REF} binding={binding()} candidates={[BOB, CAROL]} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Bind" }));
    const dialog = screen.getByRole("dialog");
    expect(hooks.bind.mutate).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Bind" }));
    expect(hooks.bind.mutate).toHaveBeenCalledWith(
      {
        account: { source: REF.source, source_id: REF.source_id, id: REF.account_id },
        person_id: CAROL.person_id,
      },
      expect.anything(),
    );
  });

  it("tells a confirm apart from a bind in what it promises", async () => {
    render(
      <AccountActions accountRef={REF} binding={binding()} candidates={[BOB, CAROL]} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(
      within(screen.getByRole("dialog")).getByText(/stays bound to the current person/i),
    ).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Bind" }));
    expect(
      within(screen.getByRole("dialog")).getByText(/re-bound to this person/i),
    ).toBeInTheDocument();
  });

  it("renders the server's outcome verbatim, refusals included", async () => {
    const refusal: CorrectionResponse = {
      applied: 0,
      already_decided: 0,
      items: [{ ...REF, account_id: REF.account_id, outcome: "refused" }],
    };
    hooks.detach.mutate.mockImplementation(
      (_args: unknown, opts?: { onSuccess?: (r: CorrectionResponse) => void }) =>
        opts?.onSuccess?.(refusal),
    );
    const onDecided = vi.fn();
    render(
      <AccountActions
        accountRef={REF}
        binding={binding()}
        candidates={[]}
        onDecided={onDecided}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /detach into a new person/i }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Detach" }),
    );

    expect(screen.getByText(/1 refused/i)).toBeInTheDocument();
    expect(screen.getByText(/0 applied/i)).toBeInTheDocument();
    expect(onDecided).not.toHaveBeenCalled();
    expect(toastsOf(hooks.toast.add, "error")).toHaveLength(1);
  });

  it("hands the window back when every account it named was decided", async () => {
    const applied: CorrectionResponse = {
      applied: 1,
      already_decided: 0,
      items: [{ ...REF, account_id: REF.account_id, outcome: "applied" }],
    };
    hooks.bind.mutate.mockImplementation(
      (_args: unknown, opts?: { onSuccess?: (r: CorrectionResponse) => void }) =>
        opts?.onSuccess?.(applied),
    );
    const onDecided = vi.fn();
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[BOB, CAROL]}
        onDecided={onDecided}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Bind" }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Bind" }),
    );

    expect(onDecided).toHaveBeenCalledOnce();
    expect(toastsOf(hooks.toast.add, "success")).toHaveLength(1);
    expect(screen.queryByText(/1 applied/i)).not.toBeInTheDocument();
  });

  it("hands the window back on already-decided too, saying nothing changed", async () => {
    const already: CorrectionResponse = {
      applied: 0,
      already_decided: 1,
      items: [
        { ...REF, account_id: REF.account_id, outcome: "already_decided" },
      ],
    };
    hooks.exclude.mutate.mockImplementation(
      (_args: unknown, opts?: { onSuccess?: (r: CorrectionResponse) => void }) =>
        opts?.onSuccess?.(already),
    );
    const onDecided = vi.fn();
    render(
      <AccountActions
        accountRef={REF}
        binding={binding()}
        candidates={[]}
        onDecided={onDecided}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /exclude \(bot/i }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Exclude" }),
    );

    expect(onDecided).toHaveBeenCalledOnce();
    expect(toastsOf(hooks.toast.add, "success")).toContainEqual(expect.objectContaining({ title: "Already decided — nothing changed." }));
  });

  it("locks every verb while one is in flight", () => {
    hooks.bind.isPending = true;
    render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[BOB, CAROL]}
      />,
    );

    for (const name of [
      "Confirm",
      "Bind",
      /detach into a new person/i,
      /exclude \(bot/i,
    ]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("promises the queue only for an account that is on it", async () => {
    const { rerender } = render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: null })}
        candidates={[CAROL]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /^bind$/i }));
    expect(
      within(screen.getByRole("dialog")).queryByText(/leaves the queue/i),
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );

    rerender(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: null })}
        candidates={[CAROL]}
        queued
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^bind$/i }));
    expect(
      within(screen.getByRole("dialog")).getByText(/leaves the queue/i),
    ).toBeInTheDocument();
  });

  it("says bound for an account nobody holds and re-bound for one that is held", async () => {
    const { rerender } = render(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: null })}
        candidates={[CAROL]}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /^bind$/i }));
    expect(
      within(screen.getByRole("dialog")).getByText(
        /^The account is bound to this person\.$/,
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );

    rerender(
      <AccountActions
        accountRef={REF}
        binding={binding({ person_id: BOB.person_id })}
        candidates={[CAROL]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^bind$/i }));
    expect(
      within(screen.getByRole("dialog")).getByText(/is re-bound to this person/i),
    ).toBeInTheDocument();
  });

  it("clears a previous attempt's counters when the next one succeeds", async () => {
    const refusal: CorrectionResponse = {
      applied: 0,
      already_decided: 0,
      items: [{ ...REF, account_id: REF.account_id, outcome: "refused" }],
    };
    hooks.exclude.mutate.mockImplementation(
      (_args: unknown, opts?: { onSuccess?: (r: CorrectionResponse) => void }) =>
        opts?.onSuccess?.(refusal),
    );
    hooks.detach.mutate.mockImplementation(
      (_args: unknown, opts?: { onSuccess?: (r: CorrectionResponse) => void }) =>
        opts?.onSuccess?.({
          applied: 1,
          already_decided: 0,
          items: [{ ...REF, account_id: REF.account_id, outcome: "applied" }],
        }),
    );
    render(<AccountActions accountRef={REF} binding={binding()} candidates={[]} />);

    await userEvent.click(screen.getByRole("button", { name: /exclude \(bot/i }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Exclude" }),
    );
    expect(screen.getByText(/1 refused/i)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: /detach into a new person/i }),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Detach" }),
    );

    expect(screen.queryByText(/1 refused/i)).not.toBeInTheDocument();
  });

  it("cancelling a dialog resets the verbs, so the next one opens clean", async () => {
    render(<AccountActions accountRef={REF} binding={binding()} candidates={[]} />);

    await userEvent.click(screen.getByRole("button", { name: /exclude \(bot/i }));
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );

    expect(hooks.exclude.reset).toHaveBeenCalled();
    expect(hooks.bind.reset).toHaveBeenCalled();
  });

  it("a failed verb keeps the dialog open with the server's reason", async () => {
    hooks.exclude.isError = true;
    const { IdentityApiError } = await import("@/api/identity-client");
    hooks.exclude.error = new IdentityApiError(400, {
      context: { field_violations: [{ field: "account", description: "account not found" }] },
    });
    render(<AccountActions accountRef={REF} binding={binding()} candidates={[]} />);

    await userEvent.click(screen.getByRole("button", { name: /exclude \(bot/i }));
    const dialog = screen.getByRole("dialog");

    expect(within(dialog).getByText("account not found")).toBeInTheDocument();
  });
});
