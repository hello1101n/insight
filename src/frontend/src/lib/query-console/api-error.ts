import { AnalyticsApiError } from "@/api/analytics-client";
import { IdentityApiError } from "@/api/identity-client";

export function apiErrorReason(error: unknown, fallback: string): string {
  if (error instanceof AnalyticsApiError || error instanceof IdentityApiError) {
    const reason =
      firstFieldViolation(error.body) ?? contextReason(error.body);
    if (reason) return reason;
  }
  return fallback;
}

function firstFieldViolation(body: unknown): string | null {
  const context = errorContext(body);
  if (!context) return null;
  const violations = (context as { field_violations?: unknown })
    .field_violations;
  if (!Array.isArray(violations) || violations.length === 0) return null;
  const description = (violations[0] as { description?: unknown }).description;
  return typeof description === "string" ? description : null;
}

function contextReason(body: unknown): string | null {
  const context = errorContext(body);
  if (!context) return null;
  const reason = (context as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() !== "" ? reason : null;
}

function errorContext(body: unknown): object | null {
  if (typeof body !== "object" || body === null) return null;
  const context = (body as { context?: unknown }).context;
  return typeof context === "object" && context !== null ? context : null;
}
