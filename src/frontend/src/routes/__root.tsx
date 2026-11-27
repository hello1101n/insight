import { Outlet, createRootRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Toaster, TooltipProvider } from "@gears-frontx/ui-kit";
import { getPerson } from "@/api/identity-client";
import { authStore, getViewerPersonId, signIn } from "@/auth";
import { AuthGate } from "@/components/auth-gate";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { normalizePersonId } from "@/lib/metrics/entity";
import { TOOLTIP_DELAY_MS } from "@/lib/tooltip-delay";
import { queryClient } from "@/query-client";
import { FeedbackDialogProvider } from "@/components/feedback-dialog-provider";
import { MetricEvidenceDialogProvider } from "@/components/metric-evidence-dialog-provider";

export async function prefetchViewerIdentity(): Promise<void> {
  const personId = getViewerPersonId();
  if (!personId) return;
  await queryClient.prefetchQuery({
    queryKey: ["identity", "person", normalizePersonId(personId)],
    queryFn: ({ signal }) => getPerson(personId, signal),
  });
}

export const Route = createRootRoute({
  beforeLoad: async () => {
    const { status } = authStore.getSnapshot();
    if (status === "authenticated") {
      await prefetchViewerIdentity();
      return;
    }
    signIn(window.location.pathname + window.location.search);
  },
  component: RootLayout,
  pendingComponent: RootPending,
  pendingMs: 0,
});

function RootPending() {
  return <CenteredSpinner className="min-h-screen w-full" />;
}

function RootLayout() {
  const { t } = useTranslation();

  return (
    <TooltipProvider delay={TOOLTIP_DELAY_MS}>
      <MetricEvidenceDialogProvider>
        <FeedbackDialogProvider>
          <AuthGate>
            <Outlet />
          </AuthGate>
          <Toaster
            label={t("common.a11y.notifications")}
            closeLabel={t("common.actions.close")}
          />
        </FeedbackDialogProvider>
      </MetricEvidenceDialogProvider>
    </TooltipProvider>
  );
}
