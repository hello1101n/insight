import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import type { DateRange } from "@/api/period-to-date-range";
import { MetricCell, UnitNote } from "@/components/portal/metrics-table";
import {
  PersonalRecordsDialog,
  type PersonalRecordsTarget,
} from "@/components/portal/personal-records-dialog";
import type { MembersGridMember } from "@/components/widgets/dashboard/members-grid";
import { finiteValue, type NormalizedMetricResult } from "@/lib/metrics/collection";
import type { PersonalMetricDefinition } from "@/lib/portal/personal-metrics";
import { compareGaps, formatGap } from "@/lib/portal/metrics-view";
import { cn } from "@/lib/utils";

const STICKY_START = "sticky start-0 z-10 bg-card";
const GAP_SLOT = "ms-2 inline-block w-14 text-start text-xs font-normal text-muted-foreground";
const NO_PERSONAL: ReadonlyMap<string, PersonalMetricDefinition> = new Map();

export function MetricsCompareTable({
  people,
  keys,
  byKey,
  roles,
  personal = NO_PERSONAL,
  range,
}: {
  people: readonly MembersGridMember[];
  keys: readonly string[];
  byKey: ReadonlyMap<string, NormalizedMetricResult>;
  roles: ReadonlyMap<string, string>;
  personal?: ReadonlyMap<string, PersonalMetricDefinition>;
  range?: DateRange;
}) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<PersonalRecordsTarget | null>(null);
  return (
    <div className="max-h-[75svh] overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">{t("metrics_view.compare_caption")}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className={cn(STICKY_START, "top-0 z-20 border-b px-3 py-2 text-start text-xs font-medium tracking-wider text-muted-foreground uppercase")}
            >
              Metric
            </th>
            {people.map((person) => (
              <th
                key={person.entityId}
                scope="col"
                className="sticky top-0 z-10 border-b bg-card px-3 py-2 text-end font-medium"
              >
                <Link
                  to="/people/$person"
                  params={{ person: person.entityId }}
                  className="hover:underline"
                >
                  {person.displayName}
                </Link>
                <span aria-hidden className={GAP_SLOT} />
                {roles.get(person.entityId) ? (
                  <span className="block pe-16 text-xs font-normal text-muted-foreground">
                    {roles.get(person.entityId)}
                  </span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keys.flatMap((key) => {
            const result = byKey.get(key);
            if (!result) return [];

            const cells = compareGaps(
              people.map((person) => finiteValue(result, person.entityId)),
              result.direction,
            );

            return [
              <tr key={key} className="hover:bg-muted/50">
                <th
                  scope="row"
                  className={cn(STICKY_START, "border-b px-3 py-1.5 text-start font-normal")}
                >
                  {result.label}
                  <UnitNote result={result} className="ms-1.5 text-xs" />
                </th>
                {people.map((person, index) => {
                  const cell = cells[index]!;
                  return (
                    <td
                      key={person.entityId}
                      className={cn(
                        "border-b px-3 py-1.5 text-end tabular-nums",
                        cell.best && "font-semibold",
                      )}
                    >
                      <MetricCell
                        metricKey={key}
                        byKey={byKey}
                        entityId={person.entityId}
                        personName={person.displayName}
                        onOpen={
                          personal.get(key) && range
                            ? (value) =>
                                setRecords({
                                  metric: personal.get(key)!,
                                  personId: person.entityId,
                                  personName: person.displayName,
                                  value,
                                })
                            : undefined
                        }
                      />
                      {cell.best ? <span className="sr-only"> (best)</span> : null}
                      <span className={GAP_SLOT}>{formatGap(cell.gap)}</span>
                    </td>
                  );
                })}
              </tr>,
            ];
          })}
        </tbody>
      </table>
      {range ? (
        <PersonalRecordsDialog
          target={records}
          range={range}
          onClose={() => setRecords(null)}
        />
      ) : null}
    </div>
  );
}
