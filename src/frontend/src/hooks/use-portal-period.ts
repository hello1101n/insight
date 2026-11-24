import { useCallback, useMemo } from "react";
import { recordUsageEvent } from "@/telemetry";

import {
  comparisonRange,
  resolveDateRange,
  validateDateRange,
  type DateRange,
} from "@/api/period-to-date-range";
import { usePortalSearch, useSetPortalSearch } from "@/lib/portal/portal-search";
import { usePeriodPreference, writePeriodPreference } from "@/hooks/use-period";
import type { CustomRange, PeriodValue } from "@/types/insight";

export function usePortalPeriod(): {
  period: PeriodValue;
  customRange: CustomRange | null;
  dateRange: DateRange;
  compareTo: DateRange;
  comparisonNoun: PeriodValue | "period";
  setPeriod: (period: PeriodValue) => void;
  setCustomRange: (range: CustomRange | null) => void;
} {
  const search = usePortalSearch();
  const setSearch = useSetPortalSearch();
  const preference = usePeriodPreference();

  const period = search.period ?? preference;
  const customRange = useMemo(
    () => (search.from && search.to ? { from: search.from, to: search.to } : null),
    [search.from, search.to],
  );
  const dateRange = useMemo(
    () => resolveDateRange(period, customRange),
    [period, customRange],
  );
  const compareTo = useMemo(
    () => comparisonRange(dateRange, period, customRange),
    [dateRange, period, customRange],
  );
  const comparisonNoun = customRange ? "period" : period;

  const setPeriod = useCallback(
    (next: PeriodValue) => {
      recordUsageEvent("period", next);
      writePeriodPreference(next);
      setSearch({ period: next, from: undefined, to: undefined });
    },
    [setSearch],
  );
  const setCustomRange = useCallback(
    (range: CustomRange | null) => {
      if (range && !validateDateRange(range).valid) return;
      recordUsageEvent("period", range ? "custom" : "preset");
      setSearch({ from: range?.from, to: range?.to });
    },
    [setSearch],
  );

  return useMemo(
    () => ({
      period,
      customRange,
      dateRange,
      compareTo,
      comparisonNoun,
      setPeriod,
      setCustomRange,
    }),
    [period, customRange, dateRange, compareTo, comparisonNoun, setPeriod, setCustomRange],
  );
}
