import { createFileRoute, redirect } from "@tanstack/react-router";

import { getViewerPersonId } from "@/auth";
import { bareLandingZone } from "@/lib/portal/landing-zone";
import { getPortalShowPlanned } from "@/lib/portal/portal-store";
import { linkTo } from "@/lib/portal/portal-routes";
import { validateGlobalSearch } from "@/lib/portal/portal-search";

export const Route = createFileRoute("/")({
  validateSearch: validateGlobalSearch,
  beforeLoad: ({ search }) => {
    const person = getViewerPersonId();
    const zone = bareLandingZone(getPortalShowPlanned());
    if (zone === "overview") throw redirect({ ...linkTo({ zone }), search });
    throw redirect({ ...(person ? linkTo({ zone, person }) : { to: "/dashboards" }), search });
  },
});
