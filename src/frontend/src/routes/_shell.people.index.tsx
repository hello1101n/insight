import { createFileRoute, redirect } from "@tanstack/react-router";

import { getViewerPersonId } from "@/auth";

export const Route = createFileRoute("/_shell/people/")({
  beforeLoad: () => {
    const person = getViewerPersonId();
    if (!person) throw redirect({ to: "/dashboards", replace: true });
    throw redirect({ to: "/people/$person", params: { person }, replace: true });
  },
});
