import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, ChevronUp, Users } from "lucide-react";
import { useMemo } from "react";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@gears-frontx/ui-kit";
import { useIcPerson } from "@/queries/ic-dashboard";
import { recordUsageEvent, scopeLabel } from "@/telemetry";
import { useOrgScope } from "@/lib/portal/use-org-scope";
import { personDisplayName, personName } from "@/lib/identities/person-display";
import { useVisibleRoster } from "@/queries/visible-roster";
import { cn } from "@/lib/utils";

export function PersonHeader({ person }: { person: string }) {
  const navigate = useNavigate();
  const { data } = useIcPerson(person);
  const { roster } = useVisibleRoster(true);
  const supervisorPersonId = data?.parent_person_id ?? null;
  const { managerNodes } = useOrgScope();
  const scopeRoots = useMemo(
    () => new Set(managerNodes.map((n) => n.person_id.toLowerCase())),
    [managerNodes]
  );
  // SAFETY: analytics reads do not enforce the viewer's subtree (constructorfabric/insight#1995).
  const canSeeSupervisor = supervisorPersonId
    ? scopeRoots.has(supervisorPersonId.toLowerCase())
    : false;
  const manager = supervisorPersonId
    ? roster.find(
        (candidate) =>
          candidate.person_id.toLowerCase() === supervisorPersonId.toLowerCase()
      )
    : undefined;
  const reports = roster.filter(
    (candidate) =>
      candidate.manager_person_id?.toLowerCase() === person.toLowerCase()
  );

  if (!data) return null;

  const subtitle = [data.job_title, data.department]
    .filter((s) => s && s.trim())
    .join(" · ");
  const supervisorName = manager ? personName(manager) : null;
  const isManager = reports.length > 0;
  const teamTarget = isManager ? data.person_id : supervisorPersonId;
  const canScopeToTeam = teamTarget
    ? scopeRoots.has(teamTarget.toLowerCase())
    : false;

  const peers = roster
    .filter(
      (candidate) =>
        supervisorPersonId !== null &&
        candidate.manager_person_id?.toLowerCase() ===
          supervisorPersonId.toLowerCase()
    )
    .sort((a, b) => personDisplayName(a).localeCompare(personDisplayName(b)));
  const hasPeers = peers.length > 1;

  function goPerson(personId: string) {
    void navigate({ to: "/people/$person", params: { person: personId } });
  }
  function goTeam(personId: string) {
    recordUsageEvent("scope", scopeLabel({ root: personId, directOnly: false }));
    void navigate({
      to: "/people/$person/team",
      params: { person: personId },
      search: (prev) => ({ ...prev, scope: personId, direct: undefined }),
    });
  }

  const title = (
    <h1 className="truncate text-lg font-semibold tracking-tight">
      {personDisplayName(data)}
    </h1>
  );

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3 md:px-6">
      <div className="flex min-w-0 flex-col">
        {hasPeers ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex min-w-0 items-center gap-1 rounded-md text-left hover:opacity-80"
                  title="Switch teammate"
                >
                  {title}
                  <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
                </button>
              }
            />
            <DropdownMenuContent
              align="start"
              className="max-h-80 w-64 overflow-y-auto"
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel>
                  {supervisorName ? `${supervisorName}'s team` : "Team"}
                </DropdownMenuLabel>
                {peers.map((p) => {
                  const active =
                    p.person_id.toLowerCase() === data.person_id.toLowerCase();
                  return (
                    <DropdownMenuItem
                      key={p.person_id}
                      onClick={() => goPerson(p.person_id)}
                    >
                      <Check
                        className={cn(
                          "size-4",
                          active ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <span className="truncate">{personDisplayName(p)}</span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          title
        )}
        {subtitle ? (
          <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {canSeeSupervisor && supervisorPersonId && supervisorName ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => goPerson(supervisorPersonId)}
            icon={<ChevronUp className="size-3.5" />}
          >
            <span className="block max-w-40 truncate">{supervisorName}</span>
          </Button>
        ) : null}
        {teamTarget && canScopeToTeam ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => goTeam(teamTarget)}
            icon={<Users className="size-3.5" />}
          >
            {isManager ? "Team" : "Peers"}
          </Button>
        ) : null}
      </div>
    </header>
  );
}
