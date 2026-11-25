import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSearchNeedle } from "@/hooks/use-search-needle";
import { SEARCH_DEBOUNCE_MS } from "@/queries/identity-resolution";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function typeInto() {
  return renderHook(({ text }) => useSearchNeedle(text), {
    initialProps: { text: "" },
  });
}

describe("useSearchNeedle", () => {
  it("searches for the trimmed text once typing pauses", () => {
    const { result, rerender } = typeInto();

    rerender({ text: "  ada " });
    expect(result.current).toBe("");

    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(result.current).toBe("ada");
  });

  it("drops the needle the moment the box is cleared", () => {
    const { result, rerender } = typeInto();
    rerender({ text: "ada" });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));

    rerender({ text: "  " });

    expect(result.current).toBe("");
  });
});
