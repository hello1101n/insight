// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";

vi.mock("@/auth/use-auth", () => ({ useAuth: () => ({ session: null }) }));
vi.mock("@/api/sql-tokens-client", () => ({
  listSqlTokens: vi.fn(),
  createSqlToken: vi.fn(),
  removeSqlToken: vi.fn(),
}));
vi.mock("@/components/portal/person-picker", () => ({
  PersonPicker: ({ onPick }: { onPick: (person: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onPick({
          person_id: "00000000-0000-4000-8000-000000000003",
          display_name: "Picked Person",
        })
      }
    >
      pick Picked Person
    </button>
  ),
}));

import * as client from "@/api/sql-tokens-client";

import { SqlTokensView } from "./sql-tokens-view";

const list = vi.mocked(client.listSqlTokens);
const create = vi.mocked(client.createSqlToken);
const remove = vi.mocked(client.removeSqlToken);

const ENTRY = {
  token_id: "t-1",
  label: "laptop",
  created_at: "2026-11-12T10:00:00Z",
  expires_at: "2027-11-12T10:00:00Z",
  person: {
    person_id: "00000000-0000-4000-8000-000000000001",
    display_name: "Example Holder",
    username: "holder",
    email: "holder@example.com",
  },
  created_by: {
    person_id: "00000000-0000-4000-8000-000000000002",
    display_name: "Example Admin",
    username: "admin",
    email: "admin@example.com",
  },
};

const SECRET = "isql_synthetic-token-shown-once";

const CREATED = {
  token_id: "t-2",
  token: SECRET,
  person_id: "00000000-0000-4000-8000-000000000003",
  label: "ci",
  created_at: "2026-11-12T10:00:00Z",
  expires_at: "2027-11-12T10:00:00Z",
};

function renderView() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SqlTokensView />
    </QueryClientProvider>
  );
}

async function openCreateDialog(user: ReturnType<typeof userEvent.setup>) {
  renderView();
  await user.click(await screen.findByRole("button", { name: "Create token" }));
  return screen.findByRole("dialog");
}

async function submitToken(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement
) {
  await user.click(
    within(dialog).getByRole("button", { name: "pick Picked Person" })
  );
  await user.type(within(dialog).getByLabelText("Label"), "ci");
  await user.click(within(dialog).getByRole("button", { name: "Create" }));
}

beforeEach(() => {
  list.mockReset();
  create.mockReset();
  remove.mockReset();
});

describe("SqlTokensView", () => {
  it("lists each token's person, label, creation day, expiry day and creator", async () => {
    list.mockResolvedValue({ items: [ENTRY] });

    renderView();

    const row = (await screen.findByText("laptop")).closest("tr");
    if (row === null) throw new Error("no row for the token");
    expect(within(row).getByText("Example Holder")).toBeInTheDocument();
    expect(within(row).getByText("Example Admin")).toBeInTheDocument();
    expect(within(row).getByText("12 Nov 2026")).toBeInTheDocument();
    expect(within(row).getByText("12 Nov 2027")).toBeInTheDocument();
  });

  it("says so when the stand has no tokens", async () => {
    list.mockResolvedValue({ items: [] });

    renderView();

    expect(
      await screen.findByText("No personal tokens yet")
    ).toBeInTheDocument();
  });

  it("says so when the list cannot be read", async () => {
    list.mockRejectedValue(new Error("down"));

    renderView();

    expect(
      await screen.findByText("Tokens could not be loaded")
    ).toBeInTheDocument();
  });

  it("creates a token for a picked person and shows it once", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue({ items: [] });
    create.mockResolvedValue(CREATED);

    const dialog = await openCreateDialog(user);
    expect(
      within(dialog).getByRole("button", { name: "Create" })
    ).toBeDisabled();

    await submitToken(user, dialog);

    expect(create).toHaveBeenCalledWith({
      person_id: "00000000-0000-4000-8000-000000000003",
      label: "ci",
      lifetime_days: 365,
    });
    expect(await within(dialog).findByDisplayValue(SECRET)).toBeInTheDocument();
    expect(within(dialog).getByText(/not shown again/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("creates a token with the lifetime the admin picks", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue({ items: [] });
    create.mockResolvedValue(CREATED);

    const dialog = await openCreateDialog(user);
    expect(
      within(dialog).getByRole("combobox", { name: "Lifetime" })
    ).toHaveTextContent("1 year");
    await user.click(
      within(dialog).getByRole("combobox", { name: "Lifetime" })
    );
    await user.click(await screen.findByRole("option", { name: "30 days" }));
    await submitToken(user, dialog);

    expect(create).toHaveBeenCalledWith({
      person_id: "00000000-0000-4000-8000-000000000003",
      label: "ci",
      lifetime_days: 30,
    });
  });

  it("keeps the shown token on screen until Done, whatever else is pressed", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue({ items: [] });
    create.mockResolvedValue(CREATED);

    const dialog = await openCreateDialog(user);
    await submitToken(user, dialog);
    await within(dialog).findByDisplayValue(SECRET);

    await user.keyboard("{Escape}");

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByDisplayValue(SECRET)).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Close" })
    ).not.toBeInTheDocument();
  });

  it("copies the shown token", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue({ items: [] });
    create.mockResolvedValue(CREATED);

    const dialog = await openCreateDialog(user);
    await submitToken(user, dialog);
    await within(dialog).findByDisplayValue(SECRET);

    await user.click(within(dialog).getByRole("button", { name: "Copy" }));

    expect(await navigator.clipboard.readText()).toBe(SECRET);
  });

  it("keeps the dialog open with the reason when creation is refused", async () => {
    const user = userEvent.setup();
    list.mockResolvedValue({ items: [] });
    create.mockRejectedValue(new Error("refused"));

    const dialog = await openCreateDialog(user);
    await submitToken(user, dialog);

    expect(
      await within(dialog).findByText("The token could not be created")
    ).toBeInTheDocument();
  });

  it("removes a token only after it is confirmed", async () => {
    const user = userEvent.setup();
    list
      .mockResolvedValueOnce({ items: [ENTRY] })
      .mockResolvedValue({ items: [] });
    remove.mockResolvedValue(undefined);

    renderView();
    await user.click(
      await screen.findByRole("button", { name: "Remove laptop" })
    );
    expect(remove).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(remove).toHaveBeenCalledWith("t-1");
    expect(
      await screen.findByText("No personal tokens yet")
    ).toBeInTheDocument();
  });
});
