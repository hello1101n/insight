/**
 * Standalone memory-history TanStack Router for stories.
 *
 * We deliberately do NOT use the app's generated `routeTree.gen` here: a
 * story renders one component in isolation, so the router only needs to
 * provide a working `<Link>` / `useNavigate` / router context. The story
 * is mounted as the root route's `defaultNotFoundComponent` (set in
 * `with-providers.tsx`).
 */

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";

/** `zone` puts the story in a portal zone, as a shell route's `staticData` would. */
export function createTestingRouter(zone?: string) {
  const rootRoute = createRootRoute({ component: Outlet, staticData: { zone } });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({ routeTree: rootRoute, history });
  return {
    router,
    history,
    reset: () => history.replace("/"),
  };
}
