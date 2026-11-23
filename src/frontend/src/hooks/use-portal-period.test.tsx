// @vitest-environment jsdom
vi.mock("@tanstack/react-router", async () => {
  const { portalRouterMock } = await import("@/test/portal-router");
  return portalRouterMock();
});

import { renderHook } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { portalRouter } from "@/test/portal-router";

import { writePeriodPreference } from "./use-period";
import { usePortalPeriod } from "./use-portal-period";

beforeEach(() => {
  window.localStorage.clear();
  act(() => {
    portalRouter.reset();
    writePeriodPreference("week");
  });
});

describe("usePortalPeriod", () => {
  it("puts a chosen preset in the URL and clears any custom range", () => {
    const { result } = renderHook(() => usePortalPeriod());
    act(() => result.current.setPeriod("month"));
    expect(portalRouter.search.period).toBe("month");
    expect(portalRouter.search.from).toBeUndefined();
    expect(portalRouter.search.to).toBeUndefined();
  });

  it("writes a valid custom range to the URL", () => {
    const { result } = renderHook(() => usePortalPeriod());
    act(() => result.current.setCustomRange({ from: "2026-07-01", to: "2026-07-15" }));
    expect(portalRouter.search.from).toBe("2026-07-01");
    expect(portalRouter.search.to).toBe("2026-07-15");
  });

  it("drops an inverted range instead of throwing out of the handler", () => {
    const { result } = renderHook(() => usePortalPeriod());
    expect(() =>
      act(() => result.current.setCustomRange({ from: "2026-07-30", to: "2026-01-01" })),
    ).not.toThrow();
    expect(portalRouter.search.from).toBeUndefined();
    expect(portalRouter.search.to).toBeUndefined();
  });

  it.each(["week", "quarter"] as const)(
    "compares a custom range with the same number of days before it, not with the remembered %s",
    (preset) => {
      act(() => writePeriodPreference(preset));
      const { result } = renderHook(() => usePortalPeriod());
      act(() => result.current.setCustomRange({ from: "2026-10-01", to: "2026-10-31" }));
      expect(result.current.compareTo).toEqual({ from: "2026-08-31", to: "2026-09-30" });
    },
  );

  it("names the comparison by the preset, and a custom range a period", () => {
    const { result } = renderHook(() => usePortalPeriod());
    act(() => result.current.setPeriod("month"));
    expect(result.current.comparisonNoun, "preset").toBe("month");

    act(() => result.current.setCustomRange({ from: "2026-10-01", to: "2026-10-31" }));
    expect(result.current.comparisonNoun, "custom range").toBe("period");
  });
});
