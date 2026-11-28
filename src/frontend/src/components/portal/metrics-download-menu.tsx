import { useState } from "react";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from "@gears-frontx/ui-kit";
import { downloadMatrixCsv, downloadMatrixXlsx, type Matrix } from "@/lib/export/matrix";
import { recordUsageEvent } from "@/telemetry";

export function MetricsDownloadMenu({
  matrix,
  filename,
  disabled,
}: {
  matrix: () => Matrix;
  filename: (extension: "csv" | "xlsx") => string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);

  async function downloadXlsx(): Promise<void> {
    recordUsageEvent("export", "metrics-view:xlsx");
    setExporting(true);
    try {
      await downloadMatrixXlsx(filename("xlsx"), t("metrics_view.title"), matrix());
    } catch {
      toast.add({ type: "error", title: t("metrics_view.download.failed") });
    } finally {
      setExporting(false);
    }
  }

  function downloadCsv(): void {
    recordUsageEvent("export", "metrics-view:csv");
    downloadMatrixCsv(filename("csv"), matrix());
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled || exporting}
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            icon={<Download />}
            loading={exporting}
          >
            {t("common.actions.download")}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void downloadXlsx()}>
          <FileSpreadsheet className="size-4" />
          {t("metrics_view.download.xlsx")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={downloadCsv}>
          <FileText className="size-4" />
          {t("metrics_view.download.csv")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
