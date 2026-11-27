import { createFileRoute } from "@tanstack/react-router";

import { ManageLanding } from "@/components/portal/manage-landing";

export const Route = createFileRoute("/_shell/manage/")({
  staticData: { zone: "manage" },
  component: ManageLanding,
});
