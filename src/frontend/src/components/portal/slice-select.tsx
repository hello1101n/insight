import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@gears-frontx/ui-kit";
import type { SliceDim } from "@/lib/insight/slices";
import { PLANNED_SLICES } from "@/lib/insight/slices";
import { usePortalNavActions, usePortalSlice } from "@/lib/portal/portal-nav";

// WORKAROUND: Base UI Select treats "" as no selection, so "no slice" needs a non-empty value.
const TEAM_KEY = "__team__";

export function SliceSelect({ dims }: { dims: SliceDim[] }) {
  const { t } = useTranslation();
  const { setSlice } = usePortalNavActions();
  const slice = usePortalSlice();
  const teamSlice = { key: TEAM_KEY, label: t("common.cohort.team_all") };
  const all = [teamSlice, ...dims, ...PLANNED_SLICES];
  const hasChoice = dims.length + PLANNED_SLICES.length > 0;
  const current = slice || TEAM_KEY;
  const value = all.some((d) => d.key === current) ? current : TEAM_KEY;
  const label = all.find((d) => d.key === value)?.label ?? t("common.cohort.team_all");
  return (
    <Select
      value={value}
      onValueChange={(v) => setSlice(v && v !== TEAM_KEY ? v : "")}
    >
      <SelectTrigger
        size="sm"
        aria-label={t("common.cohort.label")}
        className="w-32 md:w-44"
        disabled={!hasChoice}
        title={hasChoice ? undefined : t("common.cohort.none")}
      >
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>
          <SelectLabel>
            {t("common.cohort.compare_against")}
          </SelectLabel>
          {all.map((d) => (
            <SelectItem key={d.key} value={d.key}>
              {d.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
