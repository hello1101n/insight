import { CalendarDays } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { parseISOCalendarDate, toISODate } from "@/api/period-to-date-range";
import { Calendar, ToggleGroup, ToggleGroupItem } from "@gears-frontx/ui-kit";
import {
  asTeamTimeWeeks,
  formatChangeDay,
  TEAM_TIME_WEEKS,
  type TeamTimeWeeks,
} from "@/lib/portal/metrics-team-time";

export function MetricsChangeDatePanel({
  change,
  weeks,
  latest,
  onChange,
  onWeeks,
}: {
  change: string;
  weeks: TeamTimeWeeks;
  latest: string;
  onChange: (change: string) => void;
  onWeeks: (weeks: TeamTimeWeeks) => void;
}) {
  const { t } = useTranslation();
  const day = parseISOCalendarDate(change) ?? new Date();
  const lastDay = parseISOCalendarDate(latest) ?? day;
  const headingId = useId();
  const [shown, setShown] = useState({ change, month: day });
  if (shown.change !== change) setShown({ change, month: day });

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border bg-card p-4"
    >
      <h2 id={headingId} className="flex items-center gap-2 text-base font-semibold">
        <CalendarDays className="size-4 text-muted-foreground" />
        {t("metrics_view.change_date", { date: formatChangeDay(change) })}
      </h2>
      <ToggleGroup
        spacing={0}
        value={[String(weeks)]}
        onValueChange={(values) => {
          const next = asTeamTimeWeeks(Array.isArray(values) ? values[0] : values);
          if (next) onWeeks(next);
        }}
        className="w-full"
      >
        {TEAM_TIME_WEEKS.map((option) => (
          <ToggleGroupItem
            key={option}
            value={String(option)}
            className="flex-1 aria-pressed:bg-selection-subtle"
          >
            {t("metrics_view.weeks", { count: option })}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Calendar
        mode="single"
        required
        weekStartsOn={1}
        showOutsideDays={false}
        selected={day}
        onSelect={(next) => onChange(toISODate(next))}
        month={shown.month}
        onMonthChange={(month) => setShown({ change, month })}
        endMonth={lastDay}
        disabled={{ after: lastDay }}
        className="self-center"
      />
    </section>
  );
}
