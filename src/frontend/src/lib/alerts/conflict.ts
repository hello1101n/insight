import { CustomApiError } from "@/api/custom-client";

export function isRevisionConflict(error: unknown): boolean {
  if (!(error instanceof CustomApiError) || error.status !== 409) return false;

  const violations =
    (error.body as { context?: { violations?: { type?: string }[] } } | null)
      ?.context?.violations ?? [];

  return violations.some((violation) => violation.type === "revision");
}
