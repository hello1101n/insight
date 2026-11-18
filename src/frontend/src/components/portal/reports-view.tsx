import { useTranslation } from "react-i18next";

import { ReportBuilderView } from "@/components/portal/report-builder-view";
import { ComingSoon } from "@/components/widgets/coming-soon";

export function ReportsView({ item }: { item: string | null }) {
  const { t } = useTranslation();
  if (item === "report-builder") return <ReportBuilderView />;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-lg font-semibold tracking-tight">
          {t("nav.zones.reports")}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {t("nav.pending")}
        </p>
      </div>
      <div className="w-full max-w-md">
        <ComingSoon variant="card" state="empty" label="Pending: this lens" />
      </div>
    </div>
  );
}
