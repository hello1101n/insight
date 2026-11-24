import { addDays } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { useState } from "react";

import { latestPickableDay, toISODate } from "@/api/period-to-date-range";
import {
  Button,
  Calendar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ToggleGroup,
  ToggleGroupItem,
  type CalendarProps,
} from "@gears-frontx/ui-kit";
import { keepNavigationKeysInside } from "@/lib/keep-navigation-keys-inside";
import {
  RANGE_PRESETS,
  rangeLabel,
  toInterval,
  toRangeToken,
} from "@/lib/custom/time-range";

type DayPickerRange = NonNullable<
  Extract<CalendarProps, { mode: "range" }>["selected"]
>;

export interface RangePickerProps {
  offered: string[];
  selected: string;
  onSelect: (token: string) => void;
}

export function RangePicker({ offered, selected, onSelect }: RangePickerProps) {
  const [open, setOpen] = useState(false);
  const latestEnd = addDays(latestPickableDay(), 1);
  const custom = toInterval(selected);

  const [picked, setPicked] = useState<DayPickerRange | undefined>(undefined);
  const showing =
    picked ??
    (custom
      ? {
          from: new Date(`${custom.from}T00:00:00`),
          to: new Date(`${custom.to}T00:00:00`),
        }
      : undefined);

  const presets = RANGE_PRESETS.filter((preset) =>
    offered.includes(preset.token)
  );

  return (
    <ToggleGroup
      spacing={0}
      value={[custom ? "custom" : selected]}
      onValueChange={(values) => {
        const next = Array.isArray(values) ? values[0] : values;
        if (typeof next === "string" && next !== "custom") onSelect(next);
      }}
      variant="outline"
      size="default"
      // WORKAROUND: the kit's group ships `w-fit`, which overflows instead of wrapping.
      className="max-w-full min-w-0 flex-wrap"
    >
      {presets.map(({ token, label, short }) => (
        <ToggleGroupItem key={token} value={token} aria-label={label}>
          <span className="hidden sm:inline">{label}</span>
          <span className="sm:hidden">{short}</span>
        </ToggleGroupItem>
      ))}
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setPicked(undefined);
          setOpen(next);
        }}
      >
        <PopoverTrigger
          render={
            <ToggleGroupItem
              value="custom"
              aria-label={custom ? rangeLabel(selected) : "Custom date range"}
            >
              <CalendarIcon className="size-3.5" />
              <span className="hidden sm:inline">
                {custom ? rangeLabel(selected) : "Custom"}
              </span>
            </ToggleGroupItem>
          }
        />
        <PopoverContent
          align="end"
          className="w-auto"
          onKeyDown={keepNavigationKeysInside}
        >
          <p className="border-b border-border px-4 py-3 text-xs text-muted-foreground">
            The end date is not counted — pick the day after the last one you
            want.
          </p>
          <Calendar
            mode="range"
            weekStartsOn={1}
            captionLayout="dropdown"
            fixedWeeks
            endMonth={latestEnd}
            disabled={{ after: latestEnd }}
            resetOnSelect
            showOutsideDays={false}
            selected={showing}
            onSelect={(range) => setPicked(range)}
            defaultMonth={showing?.from}
            numberOfMonths={
              typeof window !== "undefined" && window.innerWidth < 640 ? 1 : 2
            }
          />
          <div className="flex items-center justify-end gap-3 border-t border-border px-4 py-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!isWholeSpan(showing)}
              onClick={() => {
                if (!isWholeSpan(showing)) return;
                onSelect(
                  toRangeToken({
                    from: toISODate(showing.from),
                    to: toISODate(showing.to),
                  })
                );
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </ToggleGroup>
  );
}

function isWholeSpan(
  range: DayPickerRange | undefined
): range is { from: Date; to: Date } {
  return Boolean(
    range?.from && range.to && toISODate(range.from) < toISODate(range.to)
  );
}
