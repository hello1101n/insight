import { useState } from "react";

import type { PersonSummary } from "@/api/identity-client";
import { PersonDialog } from "@/components/portal/person-dialog";
import { PersonPicker } from "@/components/portal/person-picker";
import { usePortalSearch, useSetPortalSearch } from "@/lib/portal/portal-search";

export function PersonAccountsView() {
  const { person, find } = usePortalSearch();
  const setSearch = useSetPortalSearch();
  const [picked, setPicked] = useState<PersonSummary | null>(null);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <PersonPicker
        browseWhenEmpty
        asSurface
        source="roster"
        initialQuery={find ?? ""}
        onSettled={(query) =>
          setSearch({ find: query || undefined }, { replace: true })
        }
        onPick={(next: PersonSummary) => {
          setPicked(next);
          setSearch({ person: next.person_id });
        }}
      />
      <PersonDialog
        personId={person}
        card={picked}
        onClose={() => setSearch({ person: undefined })}
      />
    </div>
  );
}
