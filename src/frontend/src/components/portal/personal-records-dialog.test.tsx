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

const LINES: PersonalRecordsPage["columns"] = [
  { key: "author", label: "Author", type: "string", sortable: false, percent: false, exact: false },
  { key: "lines", label: "Lines", type: "number", sortable: false, percent: false, exact: false },
];

function records(
  rows: Array<Record<string, unknown>>,
  next_cursor: string | null = null,
  shape: Pick<PersonalRecordsPage, "columns" | "value"> = { columns: COLUMNS },
): PersonalRecordsPage {
  return { ...shape, rows: rows.map((values) => ({ values })), next_cursor };
}

function Providers({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function open(range = { from: "2026-07-01", to: "2026-07-31" }) {
  return render(
    <PersonalRecordsDialog
      target={{ metric: METRIC, personId: "person-1", personName: "Ada Lovelace", value: "12" }}
      range={range}
      onClose={vi.fn()}
    />,
    { wrapper: Providers },
  );
}

function rowOf(dialog: HTMLElement, text: string): HTMLElement {
  const row = within(dialog)
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryByText(text));
  if (!row) throw new Error(`no row shows ${text}`);
  return row;
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

  it("sums up the person's value, its calculation and the count of records", async () => {
    mocks.fetchPersonalRecords.mockResolvedValue(
      records([{ author: "Ada", share: 1 }, { author: "Grace", share: 2 }]),
    );

    open();

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("table");
    expect(within(dialog).getByText("12")).toBeInTheDocument();
    expect(within(dialog).getByText("total · 2 records")).toBeInTheDocument();
  });

  it("counts a single record as one record", async () => {
    mocks.fetchPersonalRecords.mockResolvedValue(records([{ author: "Ada", share: 1 }]));

    open();

    expect(await screen.findByText("total · 1 record")).toBeInTheDocument();
  });

  it("counts the loaded records with a plus while another page exists", async () => {
    mocks.fetchPersonalRecords
      .mockResolvedValueOnce(records([{ author: "Ada", share: 1 }], "page-2"))
      .mockReturnValueOnce(new Promise(() => undefined));

    open();

    expect(await screen.findByText("total · 1+ records")).toBeInTheDocument();
  });

  it("keeps the summary above the note that the period holds no records", async () => {
    mocks.fetchPersonalRecords.mockResolvedValue(records([]));

    open();

    expect(await screen.findByText("No records for this period")).toBeInTheDocument();
    expect(screen.getByText("total · 0 records")).toBeInTheDocument();
  });

  it("shows the period of the records and its time zone", async () => {
    mocks.fetchPersonalRecords.mockResolvedValue(records([{ author: "Ada", share: 1 }]));

    open({ from: "2025-07-01", to: "2025-07-31" });

    expect(await screen.findByText("1 Jul 2025 – 31 Jul 2025 · UTC")).toBeInTheDocument();
  });

  it("puts the Median badge on the row that holds the median value", async () => {
    mocks.fetchPersonalRecords.mockResolvedValue(
      records(
        [
          { author: "Ada", lines: 5 },
          { author: "Grace", lines: 1 },
          { author: "Lin", lines: 3 },
        ],
        null,
        { columns: LINES, value: "lines" },
      ),
    );

    open();

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("table");
    expect(within(dialog).getAllByText("Median")).toHaveLength(1);
    expect(within(rowOf(dialog, "Lin")).getByText("Median")).toBeInTheDocument();
  });

  it("puts no badge while another page of records exists", async () => {
    mocks.fetchPersonalRecords
      .mockResolvedValueOnce(
        records(
          [
            { author: "Ada", lines: 5 },
            { author: "Grace", lines: 1 },
            { author: "Lin", lines: 3 },
          ],
          "page-2",
          { columns: LINES, value: "lines" },
        ),
      )
      .mockReturnValueOnce(new Promise(() => undefined));

    open();

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("table");
    expect(within(dialog).queryByText("Median")).toBeNull();
  });

  it("puts the badge on the median of every page once the last page has loaded", async () => {
    mocks.fetchPersonalRecords
      .mockResolvedValueOnce(
        records(
          [
            { author: "Ada", lines: 5 },
            { author: "Grace", lines: 1 },
          ],
          "page-2",
          { columns: LINES, value: "lines" },
        ),
      )
      .mockResolvedValueOnce(
        records(
          [
            { author: "Lin", lines: 9 },
            { author: "Kay", lines: 7 },
          ],
          null,
          { columns: LINES, value: "lines" },
        ),
      );

    open();

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Kay");
    expect(within(dialog).getAllByText("Median")).toHaveLength(1);
    expect(within(rowOf(dialog, "Ada")).getByText("Median")).toBeInTheDocument();
  });

  it("puts no badge when the answer names no value column", async () => {
    mocks.fetchPersonalRecords.mockResolvedValue(
      records(
        [
          { author: "Ada", lines: 5 },
          { author: "Grace", lines: 1 },
          { author: "Lin", lines: 3 },
        ],
        null,
        { columns: LINES },
      ),
    );

    open();

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("table");
    expect(within(dialog).queryByText("Median")).toBeNull();
  });
});
