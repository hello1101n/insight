import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, Users } from "lucide-react";

import type { MembersGridMember } from "@/components/widgets/dashboard/members-grid";
import {
  Button,
  Checkbox,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioGroupItem,
  ToggleGroup,
  ToggleGroupItem,
} from "@gears-frontx/ui-kit";
import type { CompareTeam } from "@/lib/portal/metrics-view";
import { TEXT_EYEBROW } from "@/lib/type-scale";

type PickerMode = "people" | "team";

export function MetricsComparePicker({
  people,
  teams,
  picked,
  onCompare,
  team = null,
  onCompareTeam,
  align = "end",
}: {
  people: readonly MembersGridMember[];
  teams: readonly CompareTeam[];
  picked: readonly string[];
  onCompare: (entityIds: string[]) => void;
  team?: string | null;
  onCompareTeam: (teamId: string) => void;
  align?: "start" | "end";
}) {
  const { t } = useTranslation();
  const idPrefix = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PickerMode>("people");
  const [draft, setDraft] = useState<string[]>([]);
  const [teamDraft, setTeamDraft] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const comparedCount = people.filter((person) => picked.includes(person.entityId)).length;
  const needle = query.trim().toLocaleLowerCase();
  const matches = (name: string) => !needle || name.toLocaleLowerCase().includes(needle);
  const sortedPeople = [...people].sort((a, b) => a.displayName.localeCompare(b.displayName));

  const toggle = (entityId: string) =>
    setDraft((current) =>
      current.includes(entityId)
        ? current.filter((id) => id !== entityId)
        : [...current, entityId],
    );
  const teamPicked = (team: CompareTeam) =>
    team.memberIds.every((id) => draft.includes(id));
  const toggleTeam = (team: CompareTeam) =>
    setDraft((current) =>
      team.memberIds.every((id) => current.includes(id))
        ? current.filter((id) => !team.memberIds.includes(id))
        : [...new Set([...current, ...team.memberIds])],
    );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setMode(team ? "team" : "people");
          setDraft([...picked]);
          setTeamDraft(team);
          setQuery("");
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button type="button" variant="outline" size="sm" icon={<Users />}>
            {picked.length > 0
              ? t("metrics_view.compare_people", { count: comparedCount })
              : t("metrics_view.compare")}
          </Button>
        }
      />
      <PopoverContent align={align} className="w-80">
        <ToggleGroup
          spacing={0}
          value={[mode]}
          onValueChange={(values) => {
            const next = Array.isArray(values) ? values[0] : values;
            if (next === "people" || next === "team") setMode(next);
          }}
          className="w-full"
        >
          <ToggleGroupItem value="people" className="flex-1 aria-pressed:bg-selection-subtle">
            {t("metrics_view.mode_people")}
          </ToggleGroupItem>
          <ToggleGroupItem value="team" className="flex-1 aria-pressed:bg-selection-subtle">
            {t("metrics_view.mode_team_time")}
          </ToggleGroupItem>
        </ToggleGroup>

        {mode === "team" ? (
          <TeamTimeChoice
            teams={teams.filter((option) => matches(option.name))}
            query={query}
            onQuery={setQuery}
            picked={teamDraft}
            onPick={setTeamDraft}
            onOpen={() => {
              if (!teamDraft) return;
              onCompareTeam(teamDraft);
              setOpen(false);
            }}
          />
        ) : (
          <>
            <Input
              type="search"
              icon={<Search />}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a person or a team"
              aria-label="Find a person or a team"
            />

            <div className="flex max-h-80 flex-col gap-3 overflow-y-auto">
              {teams.some((team) => matches(team.name)) ? (
                <section className="flex flex-col gap-1">
                  <h3 className={TEXT_EYEBROW}>{t("metrics_view.teams")}</h3>
                  {teams
                    .filter((team) => matches(team.name))
                    .map((team) => {
                      const checkboxId = `${idPrefix}-team-${team.id}`;
                      return (
                        <label
                          key={team.id}
                          htmlFor={checkboxId}
                          className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-sm hover:bg-muted"
                        >
                          <Checkbox
                            id={checkboxId}
                            checked={teamPicked(team)}
                            onCheckedChange={() => toggleTeam(team)}
                          />
                          <span className="min-w-0 flex-1 truncate">{`${team.name}'s team`}</span>
                          <span aria-hidden className="text-xs text-muted-foreground tabular-nums">
                            {team.memberIds.length}
                          </span>
                        </label>
                      );
                    })}
                </section>
              ) : null}

              <section className="flex flex-col gap-1">
                <h3 className={TEXT_EYEBROW}>{t("metrics_view.people")}</h3>
                {sortedPeople
                  .filter((person) => matches(person.displayName))
                  .map((person, index) => {
                    const checkboxId = `${idPrefix}-${index}`;
                    return (
                      <label
                        key={person.entityId}
                        htmlFor={checkboxId}
                        className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-sm hover:bg-muted"
                      >
                        <Checkbox
                          id={checkboxId}
                          checked={draft.includes(person.entityId)}
                          onCheckedChange={() => toggle(person.entityId)}
                        />
                        <span className="min-w-0 truncate">{person.displayName}</span>
                      </label>
                    );
                  })}
              </section>
            </div>

            <div className="flex items-center justify-between gap-2 border-t pt-3">
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft([])}>
                Clear
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={draft.length < 2}
                onClick={() => {
                  onCompare(draft);
                  setOpen(false);
                }}
              >
                {`Compare (${draft.length})`}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TeamTimeChoice({
  teams,
  query,
  onQuery,
  picked,
  onPick,
  onOpen,
}: {
  teams: readonly CompareTeam[];
  query: string;
  onQuery: (query: string) => void;
  picked: string | null;
  onPick: (teamId: string) => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const idPrefix = useId();

  return (
    <>
      <Input
        type="search"
        icon={<Search />}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder={t("metrics_view.find_team")}
        aria-label={t("metrics_view.find_team")}
      />
      <RadioGroup
        value={picked}
        onValueChange={(value) => onPick(String(value))}
        className="flex max-h-80 flex-col gap-1 overflow-y-auto"
      >
        {teams.map((option) => {
          const radioId = `${idPrefix}-${option.id}`;
          return (
            <label
              key={option.id}
              htmlFor={radioId}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1.5 text-sm hover:bg-muted"
            >
              <RadioGroupItem id={radioId} value={option.id} />
              <span className="min-w-0 flex-1 truncate">
                {t("people.team_possessive", { name: option.name })}
              </span>
              <span aria-hidden className="text-xs text-muted-foreground tabular-nums">
                {option.memberIds.length}
              </span>
            </label>
          );
        })}
      </RadioGroup>
      <div className="flex justify-end border-t pt-3">
        <Button type="button" size="sm" disabled={!picked} onClick={onOpen}>
          {t("metrics_view.open_team")}
        </Button>
      </div>
    </>
  );
}
