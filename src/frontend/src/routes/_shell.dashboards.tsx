import {
  Navigate,
  Outlet,
  createFileRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";

import type { ChatCreated } from "@/api/custom-client";
import { CustomChat } from "@/components/custom/custom-chat";
import { CustomPageShell } from "@/components/custom/custom-page-shell";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { catalogueWithheldAt } from "@/lib/custom/catalogues";
import { dashboardIdFromPath } from "@/lib/custom/dashboard-path";
import { usePortalShowPlanned } from "@/lib/portal/portal-store";
import { validateDashboardListSearch } from "@/lib/portal/portal-search";
import { useIsAdmin } from "@/queries/identity-me";
import {
  invalidateDashboardList,
  invalidateDashboardPage,
} from "@/queries/custom";

export const Route = createFileRoute("/_shell/dashboards")({
  validateSearch: validateDashboardListSearch,
  staticData: { zone: "custom" },
  component: CustomZone,
});

const MEMBER_ROUTES = new Set(["/_shell/dashboards/", "/_shell/dashboards/$name"]);

function CustomZone() {
  const { isAdmin, isPending, isError, retry } = useIsAdmin();
  const showPlanned = usePortalShowPlanned();
  const routeId = useRouterState({ select: (s) => s.matches.at(-1)?.routeId });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const openDashboard = dashboardIdFromPath(pathname);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  function handleCreated(created: ChatCreated) {
    void invalidateDashboardList(queryClient);
    if (openDashboard) {
      void invalidateDashboardPage(queryClient, openDashboard);
    }
    if (created.dashboard) {
      void invalidateDashboardPage(queryClient, created.dashboard.id);
      void navigate({
        to: "/dashboards/$name",
        params: { name: created.dashboard.id },
      });
    }
  }

  if (catalogueWithheldAt(pathname, showPlanned)) {
    return <Navigate to="/dashboards" replace />;
  }

  if (isPending) return <CenteredSpinner className="min-h-40" />;
  if (isError) {
    return (
      <div className="mx-auto w-full max-w-md p-8">
        <ComingSoon
          variant="card"
          state="error"
          label="Couldn't check your permissions."
          onRetry={retry}
        />
      </div>
    );
  }
  if (!isAdmin) {
    const open = routeId != null && MEMBER_ROUTES.has(routeId);

    return (
      <CustomPageShell>
        {open ? (
          <Outlet />
        ) : (
          <div className="mx-auto w-full max-w-md p-8">
            <ComingSoon
              variant="card"
              state="empty"
              label="This page is open to administrators only."
            />
          </div>
        )}
      </CustomPageShell>
    );
  }

  return (
    <CustomPageShell
      chat={showPlanned ? <CustomChat onCreated={handleCreated} /> : undefined}
    >
      <Outlet />
    </CustomPageShell>
  );
}
