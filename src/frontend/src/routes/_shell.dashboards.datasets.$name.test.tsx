vi.mock("@tanstack/react-router", async () => {
  const { portalRouterMock } = await import("@/test/portal-router");
  return {
    ...portalRouterMock(),
    createFileRoute: () => (options: Record<string, unknown>) => options,
  };
});
vi.mock("@/api/custom-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/custom-client")>();
  return {
    ...actual,
    fetchDataset: vi.fn(),
    fetchDatasetRecords: vi.fn(),
    fetchDatasetDependents: vi.fn(),
    fetchMetric: vi.fn(),
    deleteDataset: vi.fn(),
  };
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as customClient from "@/api/custom-client";
import { portalRouter } from "@/test/portal-router";

import { Route } from "./_shell.dashboards.datasets.$name";

const Component = (Route as unknown as { component: () => React.ReactNode })
  .component;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

const COMMITS = {
  name: "commits",
  declaration: {
    title: "Commits",
    description: "One per commit.",
    fields: [
      {
        name: "author",
        path: "who.email",
        type: "string" as const,
        person: "email" as const,
      },
      {
        name: "day",
        path: "day",
        type: "datetime" as const,
        default_clock: true,
      },
    ],
    row_identity: ["author"],
  },
};

function onDataset(name = "commits") {
  portalRouter.go(`/dashboards/datasets/${name}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  portalRouter.reset();
  onDataset();
  vi.mocked(customClient.fetchDatasetRecords).mockResolvedValue({
    records: [],
    total: 0,
    limit: 20,
  });
  vi.mocked(customClient.fetchDatasetDependents).mockResolvedValue([]);
  vi.mocked(customClient.fetchMetric).mockRejectedValue(
    new customClient.CustomApiError(404, null)
  );
  localStorage.clear();
});

describe("/dashboards/datasets/$name", () => {
  it("offers the way back to the catalogue", async () => {
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);

    render(<Component />, { wrapper });

    expect(
      await screen.findByRole("link", { name: "Back to the catalogue" })
    ).toHaveAttribute("href", "/dashboards/datasets");
  });

  it("reads the declaration back, field by field", async () => {
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);

    render(<Component />, { wrapper });

    expect(await screen.findByText("One per commit.")).toBeInTheDocument();
    expect(await screen.findByText("author")).toBeInTheDocument();
    expect(await screen.findByText("main date")).toBeInTheDocument();
    expect(await screen.findByText("person")).toBeInTheDocument();
    expect(
      await screen.findByText("One record per author.")
    ).toBeInTheDocument();
  });

  it("shows the records as a table of the declared fields", async () => {
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetRecords).mockResolvedValue({
      records: [
        {
          id: "1",
          received_at: "2026-09-17 10:00:00",
          raw_data: { day: "2026-09-17", who: { email: "ada@example.com" } },
        },
      ],
      total: 757,
      limit: 20,
    });

    render(<Component />, { wrapper });

    expect(
      await screen.findByRole("columnheader", { name: "author" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("cell", { name: "ada@example.com" })
    ).toBeInTheDocument();
    expect(customClient.fetchDatasetRecords).toHaveBeenCalledWith("commits", {
      offset: 0,
      orderBy: "received_at",
      descending: true,
    });
  });

  it("says which records of the whole this page is", async () => {
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetRecords).mockResolvedValue({
      records: [
        {
          id: "1",
          received_at: "2026-09-17 10:00:00",
          raw_data: { who: { email: "ada@example.com" } },
        },
      ],
      total: 757,
      limit: 20,
    });

    render(<Component />, { wrapper });

    expect(
      await screen.findByText("1–1 of 757 records received")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("asks for the next page, and for the order the reader picked", async () => {
    const user = userEvent.setup();
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetRecords).mockResolvedValue({
      records: [
        {
          id: "1",
          received_at: "2026-09-17 10:00:00",
          raw_data: { who: { email: "ada@example.com" } },
        },
      ],
      total: 757,
      limit: 20,
    });

    render(<Component />, { wrapper });
    await screen.findByRole("cell", { name: "ada@example.com" });

    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(customClient.fetchDatasetRecords).toHaveBeenCalledWith("commits", {
        offset: 20,
        orderBy: "received_at",
        descending: true,
      })
    );

    await user.click(screen.getByRole("button", { name: /Order by author/ }));
    await waitFor(() =>
      expect(customClient.fetchDatasetRecords).toHaveBeenCalledWith("commits", {
        offset: 0,
        orderBy: "author",
        descending: true,
      })
    );
  });

  it("offers the way back to the first page when a page is refused", async () => {
    const user = userEvent.setup();
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetRecords)
      .mockResolvedValueOnce({
        records: [
          {
            id: "1",
            received_at: "2026-09-17 10:00:00",
            raw_data: { who: { email: "ada@example.com" } },
          },
        ],
        total: 757,
        limit: 20,
      })
      .mockRejectedValue(new Error("boom"));

    render(<Component />, { wrapper });
    await screen.findByRole("cell", { name: "ada@example.com" });
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to the first page" })
    ).toBeEnabled();
  });

  it("stops at a page that holds nothing rather than walking further", async () => {
    const user = userEvent.setup();
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetRecords)
      .mockResolvedValueOnce({
        records: [
          {
            id: "1",
            received_at: "2026-09-17 10:00:00",
            raw_data: { who: { email: "ada@example.com" } },
          },
        ],
        total: 757,
        limit: 20,
      })
      .mockResolvedValue({ records: [], total: 757, limit: 20 });

    render(<Component />, { wrapper });
    await screen.findByRole("cell", { name: "ada@example.com" });
    await user.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Next" })).toBeDisabled()
    );
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("draws the page when the stored columns are not a list of names", async () => {
    localStorage.setItem(
      "insight.custom.dataset.commits.columns",
      '{"not": "a list"}'
    );
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetRecords).mockResolvedValue({
      records: [
        {
          id: "1",
          received_at: "2026-09-17 10:00:00",
          raw_data: { who: { email: "ada@example.com" } },
        },
      ],
      total: 1,
      limit: 20,
    });

    render(<Component />, { wrapper });

    expect(
      await screen.findByRole("cell", { name: "ada@example.com" })
    ).toBeInTheDocument();
  });

  it("opens the whole record when a row is clicked", async () => {
    const user = userEvent.setup();
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetRecords).mockResolvedValue({
      records: [
        {
          id: "1",
          received_at: "2026-09-17 10:00:00",
          raw_data: { who: { email: "ada@example.com" } },
        },
      ],
      total: 1,
      limit: 20,
    });

    render(<Component />, { wrapper });
    await user.click(
      await screen.findByRole("cell", { name: "ada@example.com" })
    );

    expect(screen.getByText(/"email": "ada@example.com"/)).toBeInTheDocument();
  });

  it("names the metrics that read it", async () => {
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetDependents).mockResolvedValue([
      "lines_per_day",
    ]);

    render(<Component />, { wrapper });

    expect(await screen.findByText("lines_per_day")).toBeInTheDocument();
  });

  it("names a metric that reads it by its stored name, and links it by id", async () => {
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetDependents).mockResolvedValue(["m-2"]);
    vi.mocked(customClient.fetchMetric).mockResolvedValue({
      name: "Lines per day",
      definition: { dataset: "commits", fields: [] },
    });

    render(<Component />, { wrapper });

    expect(
      await screen.findByRole("link", { name: "Lines per day" })
    ).toHaveAttribute("href", "/dashboards/metrics/m-2");
    expect(customClient.fetchMetric).toHaveBeenCalledWith("m-2");
  });

  it("links a metric that reads it to its page", async () => {
    vi.mocked(customClient.fetchDataset).mockResolvedValue(COMMITS);
    vi.mocked(customClient.fetchDatasetDependents).mockResolvedValue([
      "lines_per_day",
    ]);

    render(<Component />, { wrapper });

    expect(
      await screen.findByRole("link", { name: "lines_per_day" })
    ).toHaveAttribute("href", "/dashboards/metrics/lines_per_day");
  });

  it("says which dataset is missing rather than reading anything else", async () => {
    vi.mocked(customClient.fetchDataset).mockRejectedValue(
      new customClient.CustomApiError(404, {
        detail: "dataset `commits` was not found",
      })
    );

    render(<Component />, { wrapper });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "dataset `commits` was not found"
    );
    expect(customClient.fetchDatasetRecords).not.toHaveBeenCalled();
    expect(customClient.fetchDatasetDependents).not.toHaveBeenCalled();
  });
});
