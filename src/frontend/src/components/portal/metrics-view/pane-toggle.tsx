import { useTranslation } from "react-i18next";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { Button } from "@gears-frontx/ui-kit";
import {
  setMetricsViewPaneShown,
  useMetricsViewPaneShown,
} from "@/lib/portal/metrics-view-pane";
import { useShellLayout } from "@/lib/portal/use-shell-layout";

export function PaneToggle() {
  const { t } = useTranslation();
  const shown = useMetricsViewPaneShown();
  if (useShellLayout() !== "wide") return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      icon={shown ? <PanelLeftClose /> : <PanelLeftOpen />}
      onClick={() => setMetricsViewPaneShown(!shown)}
    >
      {shown ? t("metrics_view.hide_menu") : t("metrics_view.show_menu")}
    </Button>
  );
}
