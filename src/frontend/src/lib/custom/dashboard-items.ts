import type { Dashboard, DashboardItem } from "@/api/custom-client";

export function dashboardItems(dashboard: Dashboard): DashboardItem[] {
  return (
    dashboard.items ?? (dashboard.widgets ?? []).map((widget) => ({ widget }))
  );
}
