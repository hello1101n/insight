import type { PersonSummary } from "@/api/identity-client";
import { PersonPicker } from "@/components/portal/person-picker";
import { Spinner } from "@gears-frontx/ui-kit";
import { normalizePersonId } from "@/lib/metrics/entity";
import { TEXT_BODY } from "@/lib/type-scale";
import { cn } from "@/lib/utils";
import { useAdmins } from "@/queries/person-roles";

export function AdminPicker({
  exclude = [],
  onPick,
}: {
  exclude?: readonly string[];
  onPick: (person: PersonSummary) => void;
}) {
  const admins = useAdmins();

  if (admins.isPending) return <Spinner className="mx-auto" />;

  if (admins.isError || !admins.data.complete) {
    return (
      <p role="alert" className={cn(TEXT_BODY, "text-destructive")}>
        Couldn't read the administrators.
      </p>
    );
  }

  const excluded = new Set(exclude.map(normalizePersonId));
  const offered = new Set(
    [...admins.data.personIds].filter((id) => !excluded.has(id))
  );

  return <PersonPicker onlyIds={offered} onPick={onPick} />;
}
