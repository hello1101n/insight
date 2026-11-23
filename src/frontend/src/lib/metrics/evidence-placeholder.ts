import { hashKey, type QueryKey } from "@tanstack/react-query";

export function sameEvidenceSubject(
  previous: QueryKey | undefined,
  current: QueryKey
): boolean {
  if (!previous || previous.length !== current.length) return false;
  return hashKey(previous.slice(0, -1)) === hashKey(current.slice(0, -1));
}
