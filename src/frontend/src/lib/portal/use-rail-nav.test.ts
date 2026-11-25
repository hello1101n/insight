import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  zones: [] as string[],
  activeZone: "overview",
  selected: [] as string[],
  paneHidden: false,
  paneShown: [] as boolean[],
}));

vi.mock("@/lib/portal/metrics-view-pane", () => ({
  useMetricsViewHidesPane: () => mocks.paneHidden,
  setMetricsViewPaneShown: (shown: boolean) => mocks.paneShown.push(shown),
}));

vi.mock("@/lib/portal/use-zone-nav", async () => {
  const { ZONES } = await import("@/lib/portal/nav-model");
  return {
    useZoneNav: () => ({
      zones: ZONES.filter((zone) => mocks.zones.includes(zone.id)),
      activeZone: mocks.activeZone,
      selectZone: (zone: { id: string }) => mocks.selected.push(zone.id),
    }),
  };
});

import { RAIL } from "./rail-model";
import { useRailNav } from "./use-rail-nav";

const rail = (id: string) => RAIL.find((item) => item.id === id)!;

beforeEach(() => {
  mocks.zones = [];
  mocks.activeZone = "overview";
  mocks.selected = [];
  mocks.paneHidden = false;
  mocks.paneShown = [];
});

describe("useRailNav", () => {
  it("offers the rail items whose zones the viewer can see", () => {
    mocks.zones = ["person", "custom", "manage"];

    const { result } = renderHook(() => useRailNav());

    expect(result.current.items.map((item) => item.id)).toEqual([
      "dashboards",
      "people",
      "manage",
    ]);
  });

  it("highlights Explore while AI & Cost is open", () => {
    mocks.activeZone = "aicost";

    const { result } = renderHook(() => useRailNav());

    expect(result.current.activeItem).toBe("explore");
  });

  it("opens Explore on Directions", () => {
    mocks.zones = ["directions", "aicost"];

    const { result } = renderHook(() => useRailNav());
    result.current.selectItem(rail("explore"));

    expect(mocks.selected).toEqual(["directions"]);
  });

  it("opens Explore on AI & Cost when Directions is hidden", () => {
    mocks.zones = ["aicost"];

    const { result } = renderHook(() => useRailNav());
    result.current.selectItem(rail("explore"));

    expect(mocks.selected).toEqual(["aicost"]);
  });

  it("opens People on the person view", () => {
    mocks.zones = ["person", "people"];

    const { result } = renderHook(() => useRailNav());
    result.current.selectItem(rail("people"));

    expect(mocks.selected).toEqual(["person"]);
  });

  it("stays on the open page when its own rail item is picked", () => {
    mocks.zones = ["person", "people"];
    mocks.activeZone = "people";

    const { result } = renderHook(() => useRailNav());
    result.current.selectItem(rail("people"));

    expect(mocks.selected).toEqual([]);
    expect(mocks.paneShown).toEqual([]);
  });

  it("brings back the pane the Metrics view hid instead of leaving it", () => {
    mocks.zones = ["person", "people"];
    mocks.activeZone = "people";
    mocks.paneHidden = true;

    const { result } = renderHook(() => useRailNav());
    result.current.selectItem(rail("people"));

    expect(mocks.selected).toEqual([]);
    expect(mocks.paneShown).toEqual([true]);
  });
});
