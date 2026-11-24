import type { CorrectionResponse } from "@/api/identity-client";

export function combineOutcomes(
  results: readonly CorrectionResponse[],
): CorrectionResponse {
  return {
    applied: results.reduce((sum, r) => sum + r.applied, 0),
    already_decided: results.reduce((sum, r) => sum + r.already_decided, 0),
    items: results.flatMap((r) => r.items),
    new_person_id: results.findLast((r) => r.new_person_id != null)
      ?.new_person_id,
  };
}

export function refusedCount(result: CorrectionResponse): number {
  return result.items.filter((item) => item.outcome === "refused").length;
}

export function fullyDecided(result: CorrectionResponse): boolean {
  return result.applied + result.already_decided === result.items.length;
}
