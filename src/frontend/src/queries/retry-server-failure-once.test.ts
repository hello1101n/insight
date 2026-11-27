import { describe, expect, it } from "vitest";

import { AnalyticsApiError } from "@/api/analytics-client";
import { retryServerFailureOnce } from "@/queries/retry-server-failure-once";

describe("retryServerFailureOnce", () => {
  it.each([
    { failure: "a network failure", error: new TypeError("Failed to fetch") },
    { failure: "a 500", error: new AnalyticsApiError(500, {}) },
    { failure: "a 503", error: new AnalyticsApiError(503, {}) },
  ])(
    "asks again once after $failure, and never twice",
    ({ failure, error }) => {
      expect(retryServerFailureOnce(0, error), `should retry: ${failure}`).toBe(
        true
      );
      expect(
        retryServerFailureOnce(1, error),
        `should not retry twice: ${failure}`
      ).toBe(false);
    }
  );

  it.each([
    { refusal: "a busy server's 429", error: new AnalyticsApiError(429, {}) },
    { refusal: "a 400", error: new AnalyticsApiError(400, {}) },
    { refusal: "a 403", error: new AnalyticsApiError(403, {}) },
  ])("never asks again after $refusal", ({ refusal, error }) => {
    expect(
      retryServerFailureOnce(0, error),
      `should not retry: ${refusal}`
    ).toBe(false);
  });
});
