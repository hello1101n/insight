import { Navigate } from "@tanstack/react-router";

import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { manageLandingItem } from "@/lib/portal/nav-model";
import { linkTo } from "@/lib/portal/portal-routes";
import { useIsAdmin } from "@/queries/identity-me";
import { usePreviewsGate } from "@/queries/previews";

export function ManageLanding() {
  const { isAdmin, isPending } = useIsAdmin();
  const canManagePreviews = usePreviewsGate();

  if (isPending) {
    return <CenteredSpinner className="min-h-40" data-testid="manage-landing-pending" />;
  }

  const item = manageLandingItem({ isAdmin, canManagePreviews });
  if (!item) return <Navigate to="/" replace />;
  return <Navigate {...linkTo({ zone: "manage", item })} replace />;
}
