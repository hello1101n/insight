// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import type {
  AccountMatch,
  CorrectionResponse,
  PersonAccountEntry,
} from "@/api/identity-client";
import { IdentityApiError } from "@/api/identity-client";

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
    accounts: {
      data: undefined as
        | { person_id: string; accounts: PersonAccountEntry[] }
        | undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    },
    search: {
      data: undefined as { pages: { items: AccountMatch[] }[] } | undefined,
      isFetching: false,
      isFetchingNextPage: false,
      isPlaceholderData: false,
      isError: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
    },
    me: { isAdmin: true, isPending: false, isError: false, retry: vi.fn() },
    adminRole: {
      isAdmin: false,
      personRoleId: null as string | null,
      isPending: false,
      isUnknown: false,
    },
    grantAdmin: verb(),
    revokeAdmin: verb(),
    bind: verb(),
    detach: verb(),
    exclude: verb(),
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
  usePersonAccounts: () => hooks.accounts,
  useAccountList: () => hooks.search,
  useBindAccount: () => hooks.bind,
  useDetachAccount: () => hooks.detach,
  useExcludeAccount: () => hooks.exclude,
}));
vi.mock("@/queries/identity-me", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/queries/identity-me")>()),
  useIsAdmin: () => hooks.me,
}));
vi.mock("@/queries/person-roles", () => ({
  usePersonAdminRole: () => hooks.adminRole,
  useGrantAdmin: () => hooks.grantAdmin,
  useRevokeAdmin: () => hooks.revokeAdmin,
}));

import { PersonDialog } from "./person-dialog";
import { toastsOf } from "@/test/toast";

const ANN = "01900000-0000-7000-8000-0000000000a0";
const BOB = "01900000-0000-7000-8000-0000000000b0";

function entry(over: Partial<PersonAccountEntry> = {}): PersonAccountEntry {
  return {
    source: "github",
    source_id: "01900000-0000-7000-8000-00000000aa01",
    account_id: "gh-main",
    email: "ann@example.com",
    username: null,
    bound_by_operator: false,
    ...over,
  };
}

function match(over: Partial<AccountMatch> = {}): AccountMatch {
  return {
    source: "zoom",
    source_id: "01900000-0000-7000-8000-00000000aa03",
    account_id: "zm-9",
    email: null,
    username: "annlee",
    display_name: null,
    person: null,
    bound_by_operator: false,
    ...over,
  };
}

function open(card: { person_id: string; display_name?: string } | null = null) {
  return render(
    <PersonDialog personId={ANN} card={card} onClose={vi.fn()} />,
  );
}

// WORKAROUND: an open confirmation aria-hides the window, so `at(-1)` returns the window
// itself when none opened; its Cancel button tells the two apart.
function confirmation() {
  const asked = screen.getAllByRole("dialog").at(-1) as HTMLElement;
  expect(
    within(asked).getByRole("button", { name: "Cancel" }),
  ).toBeInTheDocument();
  return asked;
}

beforeEach(() => {
  hooks.me.isAdmin = true;
  hooks.me.isPending = false;
  hooks.me.isError = false;
  hooks.me.retry.mockReset();
  hooks.adminRole.isAdmin = false;
  hooks.adminRole.personRoleId = null;
  hooks.adminRole.isPending = false;
  hooks.adminRole.isUnknown = false;
  for (const verb of [
    hooks.bind,
    hooks.detach,
    hooks.exclude,
    hooks.grantAdmin,
    hooks.revokeAdmin,
  ]) {
    verb.mutate.mockReset();
    verb.reset.mockReset();
    verb.isPending = false;
    verb.isError = false;
    verb.error = null;
  }
  hooks.toast.add.mockClear();
  hooks.accounts.data = undefined;
  hooks.accounts.isLoading = false;
  hooks.accounts.isError = false;
  hooks.accounts.refetch.mockClear();
  hooks.search.data = undefined;
  hooks.search.isFetching = false;
  hooks.search.isFetchingNextPage = false;
  hooks.search.isPlaceholderData = false;
  hooks.search.isError = false;
  hooks.search.hasNextPage = false;
  hooks.search.fetchNextPage.mockClear();
});

describe("PersonDialog", () => {
  it("names the person it is about, and their id", () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    open({ person_id: ANN, display_name: "Ann Lee" });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Ann Lee")).toBeInTheDocument();
    expect(within(dialog).getByText(ANN)).toBeInTheDocument();
  });

  it("stands the id alone when it arrived without a card", () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    open(null);

    expect(screen.getByText(/unnamed person/i)).toBeInTheDocument();
  });

  it("marks a leaver in the heading, the way the roster does", () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    render(
      <PersonDialog
        personId={ANN}
        card={{ person_id: ANN, display_name: "Ann Lee", status: "terminated" }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/terminated/i)).toBeInTheDocument();
  });

  it("keeps the person's name out of the heading's class list", () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    render(
      <PersonDialog
        personId={ANN}
        card={{ person_id: ANN, display_name: "hidden Lee" }}
        onClose={vi.fn()}
      />,
    );

    const heading = screen.getByText("hidden Lee");
    expect(heading).toBeVisible();
    expect(heading.className).not.toMatch(/hidden/);
  });

  it("lists every account they hold, saying who decided each", () => {
    hooks.accounts.data = {
      person_id: ANN,
      accounts: [
        entry(),
        entry({
          source: "gitlab",
          account_id: "gl-alt",
          email: null,
          username: "alee",
          bound_by_operator: true,
        }),
      ],
    };
    open();

    expect(screen.getByText("ann@example.com")).toBeInTheDocument();
    expect(screen.getByText(/github · gh-main/)).toBeInTheDocument();
    expect(screen.getByText(/bound automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/decided by an operator/i)).toBeInTheDocument();
  });

  it("opens nothing from the accounts it lists", async () => {
    hooks.accounts.data = {
      person_id: ANN,
      accounts: [entry(), entry({ account_id: "gh-alt", email: "alt@example.com" })],
    };
    open();

    const body = screen.getByText("ann@example.com");
    await userEvent.click(body);
    await userEvent.type(body, "{Enter}");

    expect(screen.queryByRole("button", { name: /^open$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^detach ann@example\.com/i }),
    ).toBeInTheDocument();
    for (const verb of [hooks.bind, hooks.detach, hooks.exclude]) {
      expect(verb.mutate).not.toHaveBeenCalled();
    }
  });

  it("states an empty result rather than an empty list", () => {
    hooks.accounts.data = { person_id: ANN, accounts: [] };
    open();

    expect(
      screen.getByText(/no account is bound to this person/i),
    ).toBeInTheDocument();
  });

  it("offers a retry when the read fails", async () => {
    hooks.accounts.isError = true;
    open();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(hooks.accounts.refetch).toHaveBeenCalled();
  });

  it("withholds the detach that would leave them with nothing", () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    open();

    expect(screen.queryByRole("button", { name: /^detach /i })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^exclude ann@example\.com/i }),
    ).toBeInTheDocument();
  });

  it("detaches one of several accounts, in the wire shape, behind a confirmation", async () => {
    hooks.accounts.data = {
      person_id: ANN,
      accounts: [entry(), entry({ account_id: "gh-alt" })],
    };
    open();

    await userEvent.click(screen.getAllByRole("button", { name: /^detach ann@example\.com/i })[0]);
    const asked = within(confirmation());
    expect(asked.getByText(/take this account off this person/i)).toBeInTheDocument();
    expect(asked.getByText(/keeps their other accounts/i)).toBeInTheDocument();
    await userEvent.click(
      within(confirmation()).getByRole("button", { name: /^detach$/i }),
    );

    expect(hooks.detach.mutate).toHaveBeenCalledWith(
      { account: { source: "github", source_id: entry().source_id, id: "gh-main" } },
      expect.anything(),
    );
  });

  it.each([/^detach ann@example\.com/i, /^exclude ann@example\.com/i])(
    "names the account the %s confirmation acts on",
    async (verb) => {
      hooks.accounts.data = {
        person_id: ANN,
        accounts: [entry(), entry({ account_id: "gh-alt", email: "alt@example.com" })],
      };
      open();

      await userEvent.click(screen.getAllByRole("button", { name: verb })[0]);

      const asked = within(confirmation());
      expect(asked.getByText("ann@example.com")).toBeInTheDocument();
      expect(asked.getByText(/github · gh-main/)).toBeInTheDocument();
      expect(asked.queryByText("alt@example.com")).not.toBeInTheDocument();
    },
  );

  it("excludes an account behind a confirmation", async () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    open();

    await userEvent.click(screen.getByRole("button", { name: /^exclude ann@example\.com/i }));
    await userEvent.click(
      within(confirmation()).getByRole("button", { name: /^exclude$/i }),
    );

    expect(hooks.exclude.mutate).toHaveBeenCalledWith(
      { account: { source: "github", source_id: entry().source_id, id: "gh-main" } },
      expect.anything(),
    );
  });

  it("binds a found account to this person, and only after a confirmation", async () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    hooks.search.data = { pages: [{ items: [match()] }] };
    open({ person_id: ANN, display_name: "Ann Lee" });

    await userEvent.type(
      screen.getByRole("searchbox", { name: /find an account/i }),
      "annlee",
    );
    await userEvent.click(screen.getByRole("button", { name: /^annlee,/ }));
    expect(hooks.bind.mutate).not.toHaveBeenCalled();
    expect(within(confirmation()).getByText(/zoom · zm-9/)).toBeInTheDocument();
    expect(within(confirmation()).getByText("Ann Lee")).toBeInTheDocument();

    await userEvent.click(
      within(confirmation()).getByRole("button", { name: /^bind$/i }),
    );

    expect(hooks.bind.mutate).toHaveBeenCalledWith(
      {
        account: { source: "zoom", source_id: match().source_id, id: "zm-9" },
        person_id: ANN,
      },
      expect.anything(),
    );
  });

  it("names the person an account would be taken from", async () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    hooks.search.data = {
      pages: [
        { items: [match({ person: { person_id: BOB, display_name: "Bob Park" } })] },
      ],
    };
    open();

    await userEvent.type(
      screen.getByRole("searchbox", { name: /find an account/i }),
      "annlee",
    );
    await userEvent.click(screen.getByRole("button", { name: /^annlee,/ }));

    expect(
      within(confirmation()).getByText(/taken from Bob Park/i),
    ).toBeInTheDocument();
  });

  it("keeps the accounts they already hold out of the search", async () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    hooks.search.data = {
      pages: [{ items: [match(), match({ ...entry(), display_name: null })] }],
    };
    open();

    await userEvent.type(
      screen.getByRole("searchbox", { name: /find an account/i }),
      "ann",
    );

    expect(screen.getByRole("button", { name: /^annlee,/ })).toBeInTheDocument();
    expect(screen.getAllByText(/github · gh-main/)).toHaveLength(1);
  });

  it("lists no account until the field is asked something", () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    hooks.search.data = { pages: [{ items: [match()] }] };
    open();

    expect(screen.queryByText("annlee")).not.toBeInTheDocument();
    expect(screen.getByText("ann@example.com")).toBeInTheDocument();
  });

  it("locks the verbs while one is in flight", async () => {
    hooks.accounts.data = {
      person_id: ANN,
      accounts: [entry(), entry({ account_id: "gh-alt", email: "alt@example.com" })],
    };
    hooks.exclude.isPending = true;
    open();

    for (const name of [
      /^detach ann@example\.com/i,
      /^exclude ann@example\.com/i,
      /^exclude alt@example\.com/i,
    ]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("locks the confirmation's own button while its write is in flight", async () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    const { rerender } = open();

    await userEvent.click(
      screen.getByRole("button", { name: /^exclude ann@example\.com/i }),
    );
    hooks.exclude.isPending = true;
    rerender(<PersonDialog personId={ANN} card={null} onClose={vi.fn()} />);

    expect(
      within(confirmation()).getByRole("button", { name: /^exclude$/i }),
    ).toBeDisabled();
  });

  it("states a failed verb inside the confirmation it was fired from", async () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    hooks.exclude.isError = true;
    hooks.exclude.error = new Error("boom");
    open();

    await userEvent.click(
      screen.getByRole("button", { name: /^exclude ann@example\.com/i }),
    );

    expect(
      within(confirmation()).getByText(/was not applied/i),
    ).toBeInTheDocument();
  });

  it("resets every verb when a confirmation is dismissed", async () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    open();

    await userEvent.click(
      screen.getByRole("button", { name: /^exclude ann@example\.com/i }),
    );
    await userEvent.click(
      within(confirmation()).getByRole("button", { name: "Cancel" }),
    );

    for (const verb of [hooks.bind, hooks.detach, hooks.exclude]) {
      expect(verb.reset).toHaveBeenCalled();
    }
  });

  it("closes the confirmation and shows no counters when everything applied", async () => {
    hooks.exclude.mutate.mockImplementation(
      (_args: unknown, opts?: { onSuccess?: (r: CorrectionResponse) => void }) =>
        opts?.onSuccess?.({
          applied: 1,
          already_decided: 0,
          items: [{ ...entry(), outcome: "applied" }],
        }),
    );
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    open();

    await userEvent.click(
      screen.getByRole("button", { name: /^exclude ann@example\.com/i }),
    );
    await userEvent.click(
      within(confirmation()).getByRole("button", { name: /^exclude$/i }),
    );

    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByText(/refused/i)).not.toBeInTheDocument();
    expect(toastsOf(hooks.toast.add, "success")).not.toHaveLength(0);
    expect(toastsOf(hooks.toast.add, "error")).toHaveLength(0);
  });

  it("reports the minted person id, and keeps that toast up", async () => {
    const minted = "01900000-0000-7000-8000-0000000000c0";
    hooks.detach.mutate.mockImplementation(
      (_args: unknown, opts?: { onSuccess?: (r: CorrectionResponse) => void }) =>
        opts?.onSuccess?.({
          applied: 1,
          already_decided: 0,
          items: [{ ...entry(), outcome: "applied" }],
          new_person_id: minted,
        }),
    );
    hooks.accounts.data = {
      person_id: ANN,
      accounts: [entry(), entry({ account_id: "gh-alt", email: "alt@example.com" })],
    };
    open();

    await userEvent.click(
      screen.getByRole("button", { name: /^detach ann@example\.com/i }),
    );
    await userEvent.click(
      within(confirmation()).getByRole("button", { name: /^detach$/i }),
    );

    expect(toastsOf(hooks.toast.add, "success")).toContainEqual(
      expect.objectContaining({
        title: expect.any(String),
        description: expect.stringContaining(minted),
        timeout: expect.any(Number),
      }),
    );
  });

  it("reports an account that had already moved without claiming a refusal", async () => {
    hooks.exclude.mutate.mockImplementation(
      (_args: unknown, opts?: { onSuccess?: (r: CorrectionResponse) => void }) =>
        opts?.onSuccess?.({
          applied: 0,
          already_decided: 1,
          items: [{ ...entry(), outcome: "already_decided" }],
        }),
    );
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    open();

    await userEvent.click(
      screen.getByRole("button", { name: /^exclude ann@example\.com/i }),
    );
    await userEvent.click(
      within(confirmation()).getByRole("button", { name: /^exclude$/i }),
    );

    expect(toastsOf(hooks.toast.add, "success")).not.toHaveLength(0);
    expect(screen.queryByText(/refused/i)).not.toBeInTheDocument();
  });

  it("spins while the accounts are still being read", () => {
    hooks.accounts.isLoading = true;
    open();

    expect(within(screen.getByRole("dialog")).getByRole("status")).toBeInTheDocument();
  });

  it("ignores a card that belongs to somebody else", () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    render(
      <PersonDialog
        personId={ANN}
        card={{ person_id: BOB, display_name: "Bob Park" }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText("Bob Park")).not.toBeInTheDocument();
    expect(screen.getByText(/unnamed person/i)).toBeInTheDocument();
  });

  it("marks a provisional person in the heading", () => {
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    render(
      <PersonDialog
        personId={ANN}
        card={{ person_id: ANN, display_name: "Ann Lee", provisional: true }}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/provisional/i)).toBeInTheDocument();
  });

  it("keeps the server's counters when an account was refused", async () => {
    const refusal: CorrectionResponse = {
      applied: 0,
      already_decided: 0,
      items: [{ ...entry(), outcome: "refused" }],
    };
    hooks.exclude.mutate.mockImplementation(
      (_args: unknown, opts?: { onSuccess?: (r: CorrectionResponse) => void }) =>
        opts?.onSuccess?.(refusal),
    );
    hooks.accounts.data = { person_id: ANN, accounts: [entry()] };
    open();

    await userEvent.click(screen.getByRole("button", { name: /^exclude ann@example\.com/i }));
    await userEvent.click(
      within(confirmation()).getByRole("button", { name: /^exclude$/i }),
    );

    expect(screen.getByText(/1 refused/i)).toBeInTheDocument();
    expect(toastsOf(hooks.toast.add, "error")).not.toHaveLength(0);
  });
});

describe("the admin role control", () => {
  it("marks a subject who holds the admin role", () => {
    hooks.adminRole.isAdmin = true;
    hooks.adminRole.personRoleId = "pr-1";

    open();

    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("offers the grant to a subject who does not hold it", async () => {
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: "Make admin" }));

    expect(hooks.grantAdmin.mutate).toHaveBeenCalledTimes(1);
  });

  it("revokes by the assignment's own id, not the person's", async () => {
    hooks.adminRole.isAdmin = true;
    hooks.adminRole.personRoleId = "pr-1";
    const user = userEvent.setup();
    open();

    await user.click(screen.getByRole("button", { name: "Remove admin" }));

    expect(hooks.revokeAdmin.mutate).toHaveBeenCalledWith("pr-1");
  });

  it("offers nothing to a viewer who is not an admin", () => {
    hooks.me.isAdmin = false;

    open();

    expect(
      screen.queryByRole("button", { name: "Make admin" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove admin" }),
    ).not.toBeInTheDocument();
  });

  it("says the roles were not read rather than offering a verb against them", () => {
    hooks.adminRole.isUnknown = true;

    open();

    expect(
      screen.getByText("Admin status could not be read."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Make admin" }),
    ).not.toBeInTheDocument();
  });

  it("names the last-admin refusal instead of a generic failure", () => {
    hooks.adminRole.isAdmin = true;
    hooks.adminRole.personRoleId = "pr-1";
    hooks.revokeAdmin.isError = true;
    hooks.revokeAdmin.error = {
      status: 409,
      body: { context: { reason: "last_admin_protected" } },
    };

    open();

    expect(
      screen.getByText("The tenant's last admin cannot be removed."),
    ).toBeInTheDocument();
  });

  it("offers a retry when the viewer's own role could not be checked", async () => {
    hooks.me.isAdmin = false;
    hooks.me.isError = true;
    const user = userEvent.setup();

    open();

    await user.click(
      screen.getByRole("button", {
        name: "Your admin status could not be checked. Retry.",
      }),
    );
    expect(hooks.me.retry).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a viewer confirmed not to be an admin", () => {
    hooks.me.isAdmin = false;
    hooks.me.isError = false;

    open();

    expect(
      screen.queryByRole("button", {
        name: "Your admin status could not be checked. Retry.",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Make admin" }),
    ).not.toBeInTheDocument();
  });

  it("shows the service's reason when a grant fails for some other cause", () => {
    hooks.grantAdmin.isError = true;
    hooks.grantAdmin.error = new IdentityApiError(403, {
      context: { reason: "admin role required for this operation" },
    });

    open();

    expect(
      screen.getByText("admin role required for this operation"),
    ).toBeInTheDocument();
  });

  it("falls back to its own wording when the failure carries no reason", () => {
    hooks.grantAdmin.isError = true;
    hooks.grantAdmin.error = new IdentityApiError(500, null);

    open();

    expect(
      screen.getByText("The role was not changed. Try again."),
    ).toBeInTheDocument();
  });
});
