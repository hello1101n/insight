import { createFileRoute, retainSearchParams } from "@tanstack/react-router";

import { PortalLayout } from "@/components/portal/portal-layout";
import { GLOBAL_SEARCH_KEYS, validateGlobalSearch } from "@/lib/portal/portal-search";

export const Route = createFileRoute("/_shell")({
  validateSearch: validateGlobalSearch,
  search: {
    middlewares: [retainSearchParams(GLOBAL_SEARCH_KEYS)],
  },
  component: PortalLayout,
});
