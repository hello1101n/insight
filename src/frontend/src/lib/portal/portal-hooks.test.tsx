// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IdentityPerson } from "@/types/insight";
import { portalRouter } from "@/test/portal-router";

const BOSS = "11111111-1111-4111-8111-111111111111";
const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-1111-4111-8111-111111111111";
const C = "cccccccc-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  personId: "11111111-1111-4111-8111-111111111111" as string | null,
  pathname: "/" as string,
  definitions: { metrics: [] } as { metrics: unknown[] } & Record<
    string,
    unknown
  >,
  ic: {
    data: undefined as IdentityPerson | undefined,
    isPending: false,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  roster: {
    roster: [] as import("@/api/identity-client").PeopleListItem[],
    isPending: false,
    isError: false,
    retry: vi.fn(),
  },
}));

vi.mock("@/auth", () => ({
  useViewer: () => ({ email: "viewer@x", personId: mocks.personId }),
}));
vi.mock("@/queries/ic-dashboard", () => ({ useIcPerson: () => mocks.ic }));
vi.mock("@/queries/identity-me", () => ({
  useVisibilityPolicy: () => ({
    policy: "org_chart",
    isFlat: false,
    isPending: false,
  }),
}));
vi.mock("@/queries/visible-roster", () => ({
  useVisibleRoster: () => mocks.roster,
}));
vi.mock("@/api/metric-definitions-client", () => ({
  listMetricDefinitions: () => Promise.resolve(mocks.definitions),
}));
vi.mock("@tanstack/react-router", async () => {
  const { portalRouterMock } = await import("@/test/portal-router");
  return portalRouterMock();
});

import { usePortalSlice } from "./portal-nav";
import { setPortalShowPlanned } from "./portal-store";
import { useNavLocation } from "./use-nav-location";
import { useOrgScope } from "./use-org-scope";
import { usePersonCohort } from "./use-person-cohort";
import { useViewerIsManager } from "./use-viewer-is-manager";

const person = (
  personId: string,
  name: string,
  over: Partial<IdentityPerson> = {},
  subordinates: IdentityPerson[] = []
): IdentityPerson =>
  ({
    person_id: personId,
    email: `${name}@x`,
    display_name: name,
    subordinates,
    ...over,
  }) as unknown as IdentityPerson;

const TREE = person(BOSS, "boss", { division: "R&D" }, [
  person(A, "a", { division: "R&D" }),
  person(B, "b", { division: "Sales" }),
  person(C, "c", { division: "R&D" }),
]);

function rosterRows(
  root: IdentityPerson,
  managerPersonId: string | null = null,
): import("@/api/identity-client").PeopleListItem[] {
  return [
    {
      person_id: root.person_id,
      display_name: root.display_name,
      first_name: root.first_name ?? null,
      last_name: root.last_name ?? null,
      username: root.username ?? null,
      email: root.email,
      attributes: {
        ...(root.department ? { department: root.department } : {}),
        ...(root.division ? { division: root.division } : {}),
        ...(root.job_title ? { job_title: root.job_title } : {}),
        ...(root.status ? { status: root.status } : {}),
      },
      manager_person_id: managerPersonId,
      manager_name: null,
    },
    ...root.subordinates.flatMap((report) =>
      rosterRows(report, root.person_id),
    ),
  ];
}

beforeEach(() => {
  mocks.personId = BOSS;
  mocks.definitions = { metrics: [] };
  portalRouter.go("/");
  mocks.ic.data = TREE;
  mocks.ic.isPending = false;
  mocks.ic.isLoading = false;
  mocks.ic.isError = false;
  mocks.roster.roster = rosterRows(TREE);
  mocks.roster.isPending = false;
  mocks.roster.isError = false;
  act(() => {
    portalRouter.reset();
    setPortalShowPlanned(true);
  });
});

afterEach(() => vi.clearAllMocks());

describe("useNavLocation", () => {
  it("names the person the path is about", () => {
    portalRouter.go(`/people/${A}/team`);
    expect(renderHook(() => useNavLocation()).result.current).toMatchObject({
      zone: "people",
      person: A,
    });
  });

  it("falls back to the viewer off a person's pages", () => {
    portalRouter.go("/home");
    expect(renderHook(() => useNavLocation()).result.current).toMatchObject({
      zone: "overview",
      person: BOSS,
    });
  });

  it("opens on Home where no route names a zone", () => {
    portalRouter.go("/");
    expect(renderHook(() => useNavLocation()).result.current.zone).toBe("overview");
  });
});

describe("useViewerIsManager", () => {
  it("is a manager when a roster person reports to the viewer", () => {
    expect(renderHook(() => useViewerIsManager()).result.current).toEqual({
      isManager: true,
      isPending: false,
      isError: false,
    });
  });

  it("is not a manager for a leaf node (IC shell)", () => {
    mocks.personId = A;
    expect(
      renderHook(() => useViewerIsManager()).result.current.isManager
    ).toBe(false);
  });

  it("reports pending while identity resolves (callers assume manager)", () => {
    mocks.roster.roster = [];
    mocks.roster.isPending = true;
    const { result } = renderHook(() => useViewerIsManager());
    expect(result.current).toEqual({
      isManager: false,
      isPending: true,
      isError: false,
    });
  });
});

describe("usePortalSlice", () => {
  it("ignores the URL slice while planned sections are off", () => {
    act(() => setPortalShowPlanned(false));
    act(() => portalRouter.set({ slice: "division" }));
    const { result } = renderHook(() => usePortalSlice());
    expect(result.current).toBe("");

    act(() => setPortalShowPlanned(true));
    expect(result.current).toBe("division");
  });
});

describe("usePersonCohort", () => {
  const cohortOf = (id: string) =>
    renderHook(() => usePersonCohort(id), {
      wrapper: ({ children }) => (
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          {children}
        </QueryClientProvider>
      ),
    });

  it("is empty when no slice is active", () => {
    expect(cohortOf(A).result.current).toEqual([]);
  });

  it("returns everyone sharing the person's slice value", () => {
    act(() => portalRouter.set({ slice: "division" }));
    const { result } = cohortOf(A);
    expect(result.current.sort()).toEqual([A, BOSS, C].sort());
  });

  it("drops a slice the catalog does not offer, rather than comparing by it", async () => {
    mocks.definitions = {
      metrics: [],
      comparison_attributes: [{ id: "job_title", label: "Title" }],
    };
    act(() => portalRouter.set({ slice: "division" }));
    const { result } = cohortOf(A);
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("is empty when the person has no value for the slice attribute", () => {
    act(() => portalRouter.set({ slice: "title" }));
    expect(cohortOf(A).result.current).toEqual([]);
  });
});

describe("useOrgScope", () => {
  it("resolves the viewer's subtree with counts and pivot id", () => {
    const { result } = renderHook(() => useOrgScope());
    expect(result.current.rosterCount).toBe(3);
    expect(result.current.scopeMemberCount).toBe(4);
    expect(result.current.pivotPersonId).toBe(BOSS);
    expect(result.current.isLoading).toBe(false);
  });

  it("narrows to a scoped root inside the subtree", () => {
    act(() => portalRouter.set({ scope: B }));
    const { result } = renderHook(() => useOrgScope());
    expect(result.current.pivotPersonId).toBe(B);
    expect(result.current.rosterCount).toBe(0);
    expect(result.current.scopeMemberCount).toBe(1);
  });

  it("surfaces identity errors and delegates refetch", () => {
    mocks.roster.roster = [];
    mocks.roster.isError = true;
    const { result } = renderHook(() => useOrgScope());
    expect(result.current.isError).toBe(true);
    expect(result.current.pivot).toBeNull();
    result.current.refetch();
    expect(mocks.roster.retry).toHaveBeenCalledOnce();
  });
});
