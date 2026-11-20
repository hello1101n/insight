import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PeopleListItem } from "@/api/identity-client";
import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";
import {
  Badge,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@gears-frontx/ui-kit";
import { personName } from "@/lib/identities/person-display";
import { useVisibilityPolicy } from "@/queries/identity-me";
import { useVisibleRoster } from "@/queries/visible-roster";

interface EmployeeRow {
  personId: string;
  displayName: string;
  jobTitle: string;
  department: string;
  division: string;
  supervisorName: string;
  status: string;
}

function rosterEmployees(
  roster: readonly PeopleListItem[],
  unnamed: string,
): EmployeeRow[] {
  return roster
    .map((person) => ({
      personId: person.person_id,
      displayName: personName(person) ?? unnamed,
      jobTitle: person.attributes.job_title ?? "",
      department: person.attributes.department ?? "",
      division: person.attributes.division ?? "",
      supervisorName: person.manager_name ?? "",
      status: person.attributes.status ?? "",
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Employees directory — every canonical person visible to the viewer,
 * searchable and linked to their Person view.
 */
export function EmployeesView() {
  const { t } = useTranslation();
  const { isFlat } = useVisibilityPolicy();
  const visibleRoster = useVisibleRoster(true);
  const [query, setQuery] = useState("");

  const unnamed = t("identities.person.unnamed");
  const employees = useMemo(
    () => rosterEmployees(visibleRoster.roster, unnamed),
    [visibleRoster.roster, unnamed],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) =>
      [e.displayName, e.jobTitle, e.department, e.division, e.supervisorName]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [employees, query]);

  const loading = visibleRoster.isPending;
  const failed = visibleRoster.isError;
  if (loading) return <CenteredSpinner data-testid="page-people-employees" className="min-h-[60vh]" />;
  if (failed)
    return (
      <div data-testid="page-people-employees" className="mx-auto w-full max-w-md p-8">
        <ComingSoon
          variant="card"
          state="error"
          onRetry={visibleRoster.retry}
        />
      </div>
    );

  return (
    <div data-testid="page-people-employees" className="flex flex-col gap-3 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            {isFlat ? t("people.roster") : t("people.employees")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {filtered.length === employees.length
              ? t("people.people_live", { count: filtered.length })
              : t("people.people_filtered", {
                  shown: filtered.length,
                  total: employees.length,
                })}
          </p>
        </div>
        <div className="w-full max-w-xs">
          <Input
            icon={<Search />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("people.search_placeholder")}
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("people.name")}</TableHead>
              <TableHead>{t("people.title")}</TableHead>
              {/* A flat organisation fills none of these: no reporting line,
                  and the roster carries no org attributes. */}
              {isFlat ? null : (
                <>
                  <TableHead>{t("people.department")}</TableHead>
                  <TableHead>{t("people.division")}</TableHead>
                  <TableHead>{t("people.manager")}</TableHead>
                </>
              )}
              <TableHead>{t("common.table.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((e) => (
              <TableRow key={e.personId}>
                <TableCell>
                  <Link
                    to="/people/$person"
                    params={{ person: e.personId }}
                    className="font-medium hover:underline"
                  >
                    {e.displayName}
                  </Link>
                </TableCell>
                <TableCell>
                  {e.jobTitle || "—"}
                </TableCell>
                {isFlat ? null : (
                  <>
                    <TableCell>
                      {e.department || "—"}
                    </TableCell>
                    <TableCell>
                      {e.division || "—"}
                    </TableCell>
                    <TableCell>
                      {e.supervisorName || "—"}
                    </TableCell>
                  </>
                )}
                <TableCell>
                  {e.status ? (
                    <Badge
                      variant="secondary"
                    >
                      {e.status}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
