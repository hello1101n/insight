import {
  setMetricsViewPaneShown,
  useMetricsViewHidesPane,
} from "@/lib/portal/metrics-view-pane";
import { railItemFor, visibleRailItems, type RailEntry, type RailItem } from "@/lib/portal/rail-model";
import { useZoneNav } from "@/lib/portal/use-zone-nav";

export function useRailNav(): {
  items: RailEntry[];
  activeItem: string | null;
  selectItem: (item: RailItem) => void;
} {
  const { zones, activeZone, selectZone } = useZoneNav();
  const paneHidden = useMetricsViewHidesPane();
  const activeItem = railItemFor(activeZone)?.id ?? null;

  function selectItem(item: RailItem) {
    if (item.id === activeItem) {
      if (paneHidden) setMetricsViewPaneShown(true);
      return;
    }
    const target = item.zones
      .map((id) => zones.find((zone) => zone.id === id))
      .find((zone) => zone != null);
    if (target) selectZone(target);
  }

  return {
    items: visibleRailItems(zones),
    activeItem,
    selectItem,
  };
}
