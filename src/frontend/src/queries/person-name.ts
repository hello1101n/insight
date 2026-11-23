import { queryOptions, useQuery } from "@tanstack/react-query";

import { getPerson, searchPersons } from "@/api/identity-client";
import { personName } from "@/lib/identities/person-display";
import { normalizePersonId } from "@/lib/metrics/entity";
import { useIsAdmin } from "@/queries/identity-me";

export type PersonNameSource = "tenant" | "roster";

export function personNameQuery(
  personId: string,
  source: PersonNameSource = "tenant"
) {
  const id = normalizePersonId(personId);

  return queryOptions({
    queryKey: ["identity", "person-name", source, id],
    queryFn: async ({ signal }) => {
      if (source === "roster") {
        return personName(await getPerson(id, signal));
      }

      const found = await searchPersons(id, { limit: 1 }, signal);
      const person = found.items.find(
        (item) => normalizePersonId(item.person_id) === id
      );

      return (person ? personName(person) : null) ?? id;
    },
  });
}

export function usePersonName(personId: string | null) {
  const { isAdmin, isPending } = useIsAdmin();

  return useQuery({
    ...personNameQuery(personId ?? "", isAdmin ? "tenant" : "roster"),
    enabled: personId != null && personId !== "" && !isPending,
    ...(isAdmin ? {} : { retry: false }),
  });
}
