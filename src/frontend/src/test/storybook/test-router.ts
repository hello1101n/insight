import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";

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
