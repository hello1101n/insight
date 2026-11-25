import { useEffect } from "react";

import { EmployeesView } from "@/components/portal/employees-view";
import { MetricsView } from "@/components/portal/metrics-view";
import { TeamStateView } from "@/components/portal/team-state-view";
import { ComingSoon } from "@/components/widgets/coming-soon";
import { normalizePersonId } from "@/lib/metrics/entity";
import {
  usePortalNavActions,
} from "@/lib/portal/portal-nav";
import { claimScopeSync } from "@/lib/portal/route-scope-sync";

export function PeopleView({
  person,
  item,
}: {
  person: string;
  item: string | null;
}) {
  useSyncScopeFromRoute(person);

  if (item === "median-by-role") {
    return (
      <Pending label="Medians by role — not built yet" />
    );
  }
  if (item === "employees") {
    return <EmployeesView />;
  }
  if (item === "metrics") {
    return <MetricsView />;
  }
  return <TeamStateView />;
}

function useSyncScopeFromRoute(person: string): void {
  const { replaceScope } = usePortalNavActions();
  useEffect(() => {
    const id = person ? normalizePersonId(person) : "";
    if (claimScopeSync(id)) replaceScope({ root: id });
  }, [person, replaceScope]);
}

function Pending({ label }: { label: string }) {
  return (
    <div className="mx-auto w-full max-w-md p-8">
      <ComingSoon variant="card" state="empty" label={label} />
    </div>
  );
}
