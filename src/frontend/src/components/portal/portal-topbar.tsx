import { HelpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SliceSelect } from "@/components/portal/slice-select";
import {
  SidebarTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@gears-frontx/ui-kit";
import { PeriodSelectorBar } from "@/components/widgets/period-selector-bar";
import { usePortalPeriod } from "@/hooks/use-portal-period";
import { usePortalShowPlanned } from "@/lib/portal/portal-store";
import { useNavLocation } from "@/lib/portal/use-nav-location";
import { useCohortOptions } from "@/lib/portal/use-cohort-options";
import { useVisibilityPolicy } from "@/queries/identity-me";
import { cn } from "@/lib/utils";

export function PortalTopBar() {
  const { zone: activeZone } = useNavLocation();
  const filtered = activeZone !== "manage" && activeZone !== "custom";

  return (
    <div
      className={cn(
        "sticky top-0 z-20 flex items-center gap-2 border-b bg-background px-4 py-2 md:px-6",
        !filtered && "lg:hidden"
      )}
    >
      <SidebarTrigger className="shrink-0 lg:hidden" />
      {filtered ? <ViewFilters /> : null}
    </div>
  );
}

function ViewFilters() {
  const { t } = useTranslation();
  const { period, customRange, setPeriod, setCustomRange } = usePortalPeriod();
  const { dims } = useCohortOptions();
  const { isFlat } = useVisibilityPolicy();
  const showPlanned = usePortalShowPlanned();
  const cohortShown = showPlanned && !isFlat;

  return (
    <div
      role="group"
      aria-label={t("common.cohort.filters")}
      className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto md:flex-wrap md:justify-end md:overflow-x-visible"
    >
      {cohortShown ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="hidden text-xs text-muted-foreground md:inline">
            {t("common.cohort.label")}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="cursor-help text-muted-foreground"
                  aria-label={t("common.cohort.help")}
                >
                  <HelpCircle className="size-3.5" />
                </button>
              }
            />
            <TooltipContent
              side="bottom"
              className="max-w-xs"
            >
              {t("common.cohort.tooltip")}
            </TooltipContent>
          </Tooltip>
          <SliceSelect dims={dims} />
        </span>
      ) : null}
      <PeriodSelectorBar
        period={period}
        customRange={customRange}
        onPeriodChange={setPeriod}
        onRangeChange={setCustomRange}
      />
    </div>
  );
}
