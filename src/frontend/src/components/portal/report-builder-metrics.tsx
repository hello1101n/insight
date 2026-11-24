import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Info, Search, X } from "lucide-react";

import type { MetricDefinition } from "@/api/metric-definitions-client";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Checkbox,
  Input,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@gears-frontx/ui-kit";
import type { MetricFamily } from "@/lib/reports/families";
import { cn } from "@/lib/utils";
import { TEXT_BODY, TEXT_EYEBROW, TEXT_NAME } from "@/lib/type-scale";


const ALL_FAMILIES = "all";

export interface OfferedReportMetric extends MetricDefinition {
  reason: string | null;
}

interface ReportMetricPickerProps {
  families: MetricFamily<OfferedReportMetric>[];
  selected: string[];
  setSelected: Dispatch<SetStateAction<string[]>>;
}

export function ReportMetricPicker({
  families,
  selected,
  setSelected,
}: ReportMetricPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [pickedFamily, setPickedFamily] = useState(ALL_FAMILIES);
  const activeFamily =
    pickedFamily === ALL_FAMILIES ||
    families.some((family) => family.family === pickedFamily)
      ? pickedFamily
      : ALL_FAMILIES;
  const visibleFamilies = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return families
      .filter(
        (family) =>
          activeFamily === ALL_FAMILIES || family.family === activeFamily
      )
      .map((family) => ({
        family,
        metrics: family.metrics.filter((metric) =>
          matchesQuery(metric, normalizedQuery)
        ),
      }))
      .filter(({ metrics }) => metrics.length > 0);
  }, [activeFamily, families, query]);

  if (families.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No metrics are available for this scope.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 pt-3">
        <div className="px-4">
          <Input
            type="search"
            icon={<Search />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("reports.search_metrics")}
            aria-label={t("reports.search_metrics")}
          />
        </div>
        <Tabs
          value={activeFamily}
          onValueChange={(value) => setPickedFamily(String(value))}
        >
          <div className="flex overflow-x-auto overflow-y-hidden border-b px-4">
            <TabsList variant="line" className="w-max">
              <FamilyTab
                value={ALL_FAMILIES}
                label="All metrics"
                families={families}
                selected={selected}
              />
              {families.map((family) => (
                <FamilyTab
                  key={family.family}
                  value={family.family}
                  label={familyTabLabel(family.name)}
                  families={[family]}
                  selected={selected}
                />
              ))}
            </TabsList>
          </div>
        </Tabs>
      </div>

      <div className="flex flex-col gap-5 p-4">
        {visibleFamilies.map(({ family, metrics }) => (
          <MetricFamilyGroup
            key={family.family}
            family={family}
            visibleMetrics={metrics}
            selected={selected}
            setSelected={setSelected}
          />
        ))}
        {visibleFamilies.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            No metrics match this search.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function FamilyTab({
  value,
  label,
  families,
  selected,
}: {
  value: string;
  label: string;
  families: MetricFamily<OfferedReportMetric>[];
  selected: string[];
}) {
  const metrics = families.flatMap((family) => family.metrics);
  const selectedCount = metrics.filter((metric) =>
    selected.includes(metric.metric_key)
  ).length;
  const count = selectedCount
    ? `${selectedCount}/${metrics.length}`
    : String(metrics.length);

  return (
    <TabsTrigger value={value}>
      {label}
      <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
        {count}
      </span>
    </TabsTrigger>
  );
}

function MetricFamilyGroup({
  family,
  visibleMetrics,
  selected,
  setSelected,
}: {
  family: MetricFamily<OfferedReportMetric>;
  visibleMetrics: OfferedReportMetric[];
  selected: string[];
  setSelected: Dispatch<SetStateAction<string[]>>;
}) {
  const selectable = family.metrics
    .filter((metric) => metric.reason == null)
    .map((metric) => metric.metric_key);
  const selectedCount = family.metrics.filter((metric) =>
    selected.includes(metric.metric_key)
  ).length;
  const allPicked =
    selectable.length > 0 && selectable.every((key) => selected.includes(key));

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h2 className={TEXT_EYEBROW}>{family.name}</h2>
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground tabular-nums">
          {selectedCount > 0
            ? `${selectedCount} of ${family.metrics.length} selected`
            : `${family.metrics.length} metrics`}
        </span>
        {selectable.length > 0 ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() =>
              setSelected((current) =>
                allPicked
                  ? current.filter((key) => !selectable.includes(key))
                  : [...new Set([...current, ...selectable])]
              )
            }
          >
            {allPicked ? "Clear all" : "Select all"}
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2 xl:grid-cols-3">
        {visibleMetrics.map((metric) => {
          const checked = selected.includes(metric.metric_key);
          const toggle = () =>
            setSelected((current) =>
              checked
                ? current.filter((key) => key !== metric.metric_key)
                : [...current, metric.metric_key]
            );
          const row = (
            <div
              key={metric.metric_key}
              onClick={(event) => {
                if (metric.reason != null) return;
                const target = event.target as Element;
                if (
                  !event.currentTarget.contains(target) ||
                  target.closest("label, button")
                ) {
                  return;
                }
                toggle();
              }}
              className={cn(
                "flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-start text-sm",
                metric.reason
                  ? "text-muted-foreground"
                  : "hover:bg-muted",
                checked && "bg-primary/5 font-medium"
              )}
            >
              <label
                htmlFor={`report-${metric.metric_key}`}
                className={cn(
                  "flex min-w-0 items-center gap-2",
                  metric.reason == null && "cursor-pointer"
                )}
              >
                <Checkbox
                  id={`report-${metric.metric_key}`}
                  checked={checked}
                  disabled={metric.reason != null}
                  onCheckedChange={toggle}
                />
                <span className="min-w-0 flex-1 truncate" title={metric.label}>
                  {metric.label}
                </span>
              </label>
              {metric.description?.trim() ? (
                <MetricDescription
                  label={metric.label}
                  description={metric.description.trim()}
                />
              ) : null}
              <span
                aria-hidden="true"
                className="shrink-0 text-xs text-muted-foreground uppercase"
              >
                {metricTag(metric)}
              </span>
            </div>
          );
          if (metric.reason == null) return row;

          return (
            <Tooltip key={metric.metric_key}>
              <TooltipTrigger render={row} />
              <TooltipContent
                side="top"
                className="max-w-xs"
              >
                {metric.reason}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </section>
  );
}

function MetricDescription({
  label,
  description,
}: {
  label: string;
  description: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("reports.about_metric", { label })}
            className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Info className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <PopoverTitle className={TEXT_NAME}>{label}</PopoverTitle>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t("common.actions.close")}
            icon={<X />}
            onClick={() => setOpen(false)}
          />
        </div>
        <PopoverDescription className={TEXT_BODY}>{description}</PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}

function matchesQuery(
  metric: OfferedReportMetric,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return true;
  return metric.label.toLocaleLowerCase().includes(normalizedQuery);
}

function familyTabLabel(name: string): string {
  return name.replace(/^Development · /, "");
}

function metricTag(metric: OfferedReportMetric): string {
  return metric.unit ?? metric.format;
}
