import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPerson } from "@/api/identity-client";
import { queryClient } from "@/query-client";

let viewerPersonId: string | null = null;

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => null,
  createRootRoute: (opts: unknown) => ({ options: opts }),
  useRouterState: () => "/",
  Link: () => null,
}));

vi.mock("@/api/identity-client", () => ({
  getPerson: vi.fn(),
}));

vi.mock("@/auth", () => ({
  authStore: { getSnapshot: () => ({ status: "authenticated" }) },
  getViewerPersonId: () => viewerPersonId,
  signIn: vi.fn(),
  useViewer: () => ({ email: null, personId: viewerPersonId }),
}));

vi.mock("@/components/auth-gate", () => ({ AuthGate: () => null }));

import { prefetchViewerIdentity } from "./__root";

const resolve = vi.mocked(getPerson);

const PERSON_ID = "019E2804-0000-7000-8000-00000000A11C";

beforeEach(() => {
  queryClient.clear();
  resolve.mockReset();
  resolve.mockResolvedValue({
    person_id: PERSON_ID,
    email: "alice@x.io",
    display_name: "Alice",
    subordinates: [],
  } as never);
  viewerPersonId = PERSON_ID;
});

describe("prefetchViewerIdentity", () => {
  it("resolves the viewer by person_id and caches it under the normalized key", async () => {
    await prefetchViewerIdentity();

    expect(resolve).toHaveBeenCalledWith(PERSON_ID, expect.any(AbortSignal));
    expect(
      queryClient.getQueryData([
        "identity",
        "person",
        PERSON_ID.toLowerCase(),
      ]),
    ).toBeDefined();
  });

  it("does nothing without a viewer person id", async () => {
    viewerPersonId = null;

    await prefetchViewerIdentity();

    expect(resolve).not.toHaveBeenCalled();
  });
});
