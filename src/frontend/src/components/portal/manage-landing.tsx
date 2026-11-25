import { Navigate } from "@tanstack/react-router";

import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { manageLandingItem } from "@/lib/portal/nav-model";
import { linkTo } from "@/lib/portal/portal-routes";
import { useIsAdmin } from "@/queries/identity-me";

export function ManageLanding() {
  const { isAdmin, isPending } = useIsAdmin();

  if (isPending) {
    return <CenteredSpinner className="min-h-40" data-testid="manage-landing-pending" />;
  }

  const item = manageLandingItem({ isAdmin });
  if (!item) return <Navigate to="/" search replace />;
  return <Navigate {...linkTo({ zone: "manage", item })} replace />;
}
