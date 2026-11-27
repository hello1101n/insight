import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  getConnectorHealth,
  getConnectorSyncs,
  type SyncFact,
} from "@/api/connector-health-client";
import { AppTooltips } from "@/test/tooltip";

import { ConnectorHealthPane } from "./connector-health";

vi.mock("@/auth/use-auth", () => ({
  useAuth: () => ({ session: null }),
}));
vi.mock("@/api/connector-health-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/connector-health-client")>()),
  getConnectorHealth: vi.fn(),
  getConnectorSyncs: vi.fn(),
}));

const NOW = "2026-01-15T12:00:00Z";
const INSTANCE = {
  connector: "example-connector",
  source_id: "main",
  tenant_id: "example-tenant",
  configured: false,
};

async function openHistory() {
  vi.mocked(getConnectorHealth).mockResolvedValue({
    as_of: NOW,
    checked_at: NOW,
    history_available: true,
    connectors: [INSTANCE],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <AppTooltips>
        <ConnectorHealthPane />
      </AppTooltips>
    </QueryClientProvider>
  );
  const row = await screen.findByRole("row", { expanded: false });
  fireEvent.click(row);
  const panel = document.getElementById(row.getAttribute("aria-controls")!)!;
  return { row, panel: within(panel) };
}

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("reports a history read error inside the expanded connector row", async () => {
  const note = "Sync run history is unavailable.";
  vi.mocked(getConnectorSyncs).mockResolvedValue({
    connector: INSTANCE.connector,
    window: 50,
    syncs: [],
    history_read_error: note,
  });
  const { panel } = await openHistory();

  expect(await panel.findByRole("alert")).toHaveTextContent(note);
  expect(panel.getByRole("heading", { name: "Recent syncs" })).toBeVisible();
});

it("polls and updates history while the same connector row stays expanded", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const first: SyncFact = {
    job_id: "1",
    status: "succeeded",
    started_at: "2026-01-15T11:55:00Z",
    duration_ms: 10_000,
    records_reported: 7,
  };
  vi.mocked(getConnectorSyncs)
    .mockResolvedValueOnce({
      connector: INSTANCE.connector,
      window: 50,
      syncs: [first],
    })
    .mockResolvedValue({
      connector: INSTANCE.connector,
      window: 50,
      syncs: [
        { ...first, job_id: "2", started_at: NOW, records_reported: 19 },
        first,
      ],
    });
  const { row, panel } = await openHistory();
  expect(await panel.findByRole("cell", { name: "7" })).toBeVisible();

  await act(async () => vi.advanceTimersByTimeAsync(60_000));

  expect(await panel.findByRole("cell", { name: "19" })).toBeVisible();
  expect(row).toHaveAttribute("aria-expanded", "true");
});
