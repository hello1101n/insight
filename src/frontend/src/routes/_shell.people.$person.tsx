import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { isPersonId, normalizePersonId } from "@/lib/metrics/entity";

export const Route = createFileRoute("/_shell/people/$person")({
  beforeLoad: ({ params, location }) => {
    if (!isPersonId(params.person)) throw redirect({ to: "/", search: true, replace: true });
    const person = normalizePersonId(params.person);
    if (person !== params.person) {
      throw redirect({ href: location.href.replace(params.person, person), replace: true });
    }
  },
  component: Outlet,
});
