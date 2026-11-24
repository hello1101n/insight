import { createFileRoute } from "@tanstack/react-router";

import { OverviewView } from "@/components/portal/overview-view";
import { validateExploreSearch } from "@/lib/portal/portal-search";

export const Route = createFileRoute("/_shell/home/")({
  validateSearch: validateExploreSearch,
  staticData: { zone: "overview" },
  component: () => <OverviewView item="at-a-glance" />,
});
