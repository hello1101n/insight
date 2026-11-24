import { hashKey, type QueryKey } from "@tanstack/react-query";

function sameEvidenceSubject(
  previous: QueryKey | undefined,
  current: QueryKey
): boolean {
  if (!previous || previous.length !== current.length) return false;
  return hashKey(previous.slice(0, -1)) === hashKey(current.slice(0, -1));
}

export function keepRowsOnReorder(queryKey: QueryKey) {
  return <T>(
    previous: T | undefined,
    previousQuery: { queryKey: QueryKey } | undefined
  ): T | undefined =>
    sameEvidenceSubject(previousQuery?.queryKey, queryKey)
      ? previous
      : undefined;
}
