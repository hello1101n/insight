import { useEffect, useSyncExternalStore } from "react";
import { vi } from "vitest";

import type { PortalSearch } from "@/lib/portal/portal-search";

const listeners = new Set<() => void>();
function emit(): void {
  for (const fn of listeners) fn();
}

export const portalRouter = {
  search: {} as PortalSearch,
  pathname: "/home",
  navigations: [] as Array<Record<string, unknown>>,

  set(next: Partial<PortalSearch>): void {
    const merged: Record<string, unknown> = { ...this.search, ...next };
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined) delete merged[k];
    }
    this.search = merged as PortalSearch;
    emit();
  },

  go(pathname: string): void {
    this.pathname = pathname;
    emit();
  },

  reset(pathname = "/home"): void {
    this.search = {};
    this.pathname = pathname;
    this.navigations = [];
    emit();
  },
};

interface MockMatch {
  staticData: { zone?: string; item?: string };
  params: Record<string, string>;
}

export function matchesFor(pathname: string): MockMatch[] {
  const [, first, second, third, fourth] = pathname.split("/").map(decodeURIComponent);
  const at = (zone: string, params: Record<string, string | undefined>, item?: string) => [
    {
      staticData: item ? { zone, item } : { zone },
      params: Object.fromEntries(
        Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
      ),
    },
  ];

  switch (first) {
    case "home":
      return at("overview", { view: second });
    case "explore":
      return second === "ai"
        ? at("aicost", { view: third })
        : at("directions", { dir: second, lens: third });
    case "people":
      if (!second) return [];
      if (third === "team") return at("people", { person: second, view: fourth });
      return at("person", { person: second, section: third });
    case "reports":
      return at("reports", { view: second });
    case "manage":
      if (second === "identities") return at("manage", { mode: third }, "identities");
      if (second === "ingestion") return at("manage", { connector: third }, "ingestion");
      return at("manage", { surface: second });
    case "dashboards":
      return at("custom", {});
    default:
      return [];
  }
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function portalRouterMock(): Record<string, unknown> {
  const navigate = vi.fn((opts: Record<string, unknown>) => {
    portalRouter.navigations.push(opts);
    if (typeof opts.search === "function") {
      const next = (opts.search as (p: unknown) => Record<string, unknown>)(
        portalRouter.search,
      );
      portalRouter.search = {} as PortalSearch;
      portalRouter.set(next as Partial<PortalSearch>);
    } else if (opts.search) {
      portalRouter.search = {} as PortalSearch;
      portalRouter.set(opts.search as Partial<PortalSearch>);
    }
    if (typeof opts.to === "string" && opts.to !== ".") {
      const params = (opts.params ?? {}) as Record<string, string>;
      portalRouter.go(
        opts.to.replace(/\$(\w+)/g, (_, k: string) =>
          encodeURIComponent(params[k] ?? ""),
        ),
      );
    }
  });
  return {
    useNavigate: () => navigate,
    useSearch: () =>
      useSyncExternalStore(
        subscribe,
        () => portalRouter.search,
        () => portalRouter.search,
      ),
    useParams: () =>
      matchesFor(
        useSyncExternalStore(
          subscribe,
          () => portalRouter.pathname,
          () => portalRouter.pathname,
        ),
      )[0]?.params ?? {},
    useRouter: () => ({
      getMatchedRoutes: (path: string) => {
        const match = matchesFor(path)[0];
        return [match ? [{ options: { staticData: match.staticData } }] : [], match?.params ?? {}, undefined];
      },
    }),
    useMatches: () =>
      matchesFor(
        useSyncExternalStore(
          subscribe,
          () => portalRouter.pathname,
          () => portalRouter.pathname,
        ),
      ),
    useRouterState: ({ select }: { select: (s: unknown) => unknown }) => {
      const path = useSyncExternalStore(
        subscribe,
        () => portalRouter.pathname,
        () => portalRouter.pathname,
      );
      const search = useSyncExternalStore(
        subscribe,
        () => portalRouter.search,
        () => portalRouter.search,
      );
      return select({ location: { pathname: path, search }, matches: matchesFor(path) });
    },
    Outlet: () => <div data-testid="route-outlet" />,
    Navigate: ({ to, replace }: { to: string; replace?: boolean }) => {
      useEffect(() => {
        portalRouter.navigations.push({ to, replace: replace ?? false });
      }, [to, replace]);
      return null;
    },
    Link: ({
      to,
      params,
      search,
      children,
      ...rest
    }: {
      to?: string;
      params?: Record<string, string>;
      search?: Record<string, unknown> | ((prev: unknown) => Record<string, unknown>);
      children: React.ReactNode;
    } & Record<string, unknown>) => {
      const path = (to ?? "").replace(/\$(\w+)/g, (_, k: string) =>
        encodeURIComponent(params?.[k] ?? ""),
      );
      const resolved =
        typeof search === "function" ? search(portalRouter.search) : search;
      const qs = new URLSearchParams(
        Object.entries(resolved ?? {})
          .filter(([, v]) => v !== undefined && v !== "" && v !== false)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      return (
        <a href={qs ? `${path}?${qs}` : path} {...rest}>
          {children}
        </a>
      );
    },
  };
}
