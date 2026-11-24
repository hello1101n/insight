import { useSyncExternalStore } from "react";

import { resolveZoneItem } from "@/lib/portal/nav-model";
import { useNavLocation } from "@/lib/portal/use-nav-location";
import { useShellLayout } from "@/lib/portal/use-shell-layout";
import { useZoneNav } from "@/lib/portal/use-zone-nav";

let shown = false;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setMetricsViewPaneShown(next: boolean): void {
  shown = next;
  for (const listener of listeners) listener();
}

export function useMetricsViewPaneShown(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => shown,
    () => false,
  );
}

export function useMetricsViewHidesPane(): boolean {
  const { activeZone } = useZoneNav();
  const { item } = useNavLocation();
  const shown = useMetricsViewPaneShown();
  const wide = useShellLayout() === "wide";

  const metricsViewOpen =
    activeZone === "people" && resolveZoneItem("people", item) === "metrics";
  return wide && metricsViewOpen && !shown;
}
