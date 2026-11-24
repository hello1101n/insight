// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CustomApiError } from "@/api/custom-client";
import type { PersonalRecordsPage } from "@/api/personal-metrics-client";
import { personalDefinition } from "@/lib/portal/personal-metrics";

const mocks = vi.hoisted(() => ({ fetchPersonalRecords: vi.fn() }));

vi.mock("@/api/personal-metrics-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/personal-metrics-client")>()),
  fetchPersonalRecords: mocks.fetchPersonalRecords,
}));
vi.mock("@/queries/metric-definitions", () => ({
  useMetricDefinition: () => null,
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 44 })),
    getTotalSize: () => count * 44,
    measureElement: vi.fn(),
  }),
}));

import { PersonalRecordsDialog } from "./personal-records-dialog";

const METRIC = personalDefinition({
  id: "load",
  label: "Support load",
  unit: "tickets",
  format: "number",
  direction: "higher_is_better",
  description: null,
  calculation: "sum",
  shared_by: null,
});

const COLUMNS: PersonalRecordsPage["columns"] = [
  { key: "author", label: "Author", type: "string", sortable: false, percent: false, exact: false },
  { key: "share", label: "Share", type: "number", sortable: false, percent: true, exact: false },
];

function records(
  rows: Array<Record<string, unknown>>,
  next_cursor: string | null = null,
): PersonalRecordsPage {
  return { columns: COLUMNS, rows: rows.map((values) => ({ values })), next_cursor };
}

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function open() {
  return render(
    <PersonalRecordsDialog
      target={{ metric: METRIC, personId: "person-1", personName: "Ada Lovelace" }}
      range={{ from: "2026-07-01", to: "2026-07-31" }}
      onClose={vi.fn()}
    />,
    { wrapper: Providers },
  );
}

beforeEach(() => mocks.fetchPersonalRecords.mockReset());

describe("PersonalRecordsDialog", () => {
  it("asks for the person's records of the period, the end day excluded", async () => {
    mocks.fetchPersonalRecords.mockResolvedValue(records([{ author: "Ada", share: 1.234 }]));

    open();

    await screen.findByRole("table");
    expect(mocks.fetchPersonalRecords).toHaveBeenCalledWith("load", {
      person_id: "person-1",
      from: "2026-07-01",
      to: "2026-08-01",
    });
  });

  it("names the metric and the person, and shows the columns and values the answer carries", async () => {
    mocks.fetchPersonalRecords.mockResolvedValue(records([{ author: "Ada", share: 1.234 }]));

    open();

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("table");
    expect(within(dialog).getByRole("heading", { name: "Support load · Ada Lovelace" })).toBeInTheDocument();
    expect(within(dialog).getByRole("columnheader", { name: "Author" })).toBeInTheDocument();
    expect(within(dialog).getByRole("columnheader", { name: "Share" })).toBeInTheDocument();
    expect(within(dialog).getByText("1.23%")).toBeInTheDocument();
  });

  it("loads the next page, once the last row shows, with the cursor of the last page", async () => {
    mocks.fetchPersonalRecords
      .mockResolvedValueOnce(records([{ author: "Ada", share: 1 }], "page-2"))
      .mockResolvedValueOnce(records([{ author: "Grace", share: 2 }]));

    open();

    expect(await screen.findByText("Grace")).toBeInTheDocument();
    expect(mocks.fetchPersonalRecords).toHaveBeenLastCalledWith("load", {
      person_id: "person-1",
      from: "2026-07-01",
      to: "2026-08-01",
      cursor: "page-2",
    });
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("shows a failed answer inside the window with a retry", async () => {
    mocks.fetchPersonalRecords
      .mockRejectedValueOnce(new CustomApiError(500, { detail: "records are down" }))
      .mockResolvedValueOnce(records([{ author: "Ada", share: 1 }]));

    open();

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("records are down");
    await userEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(within(dialog).getByText("Ada")).toBeInTheDocument());
  });
});
