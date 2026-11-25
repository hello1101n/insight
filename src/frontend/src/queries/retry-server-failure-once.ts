import { AnalyticsApiError } from "@/api/analytics-client";

export function retryServerFailureOnce(
  failureCount: number,
  error: unknown
): boolean {
  return (
    failureCount < 1 &&
    (!(error instanceof AnalyticsApiError) || error.status >= 500)
  );
}
