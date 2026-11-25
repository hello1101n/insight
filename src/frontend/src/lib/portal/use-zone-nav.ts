import { useViewer } from "@/auth";
import { zoneHidden } from "@/lib/portal/nav-policy";
import {
  ZONES,
  ZONES_FOR_EVERYONE,
  zoneIsPlanned,
  type Zone,
} from "@/lib/portal/nav-model";
import { useGo } from "@/lib/portal/portal-nav";
import { usePortalShowPlanned } from "@/lib/portal/portal-store";
import { useNavLocation } from "@/lib/portal/use-nav-location";
import { useViewerReach } from "@/lib/portal/use-viewer-reach";
import { useIsAdmin } from "@/queries/identity-me";

export interface ZoneNav {
  zones: Zone[];
  activeZone: string;
  me: string;
  selectZone: (zone: Zone, item?: string) => void;
}

export function useZoneNav(): ZoneNav {
  const go = useGo();
  const { zone: activeZone, person: activePerson } = useNavLocation();
  const { personId: viewerPersonId } = useViewer();
  const me = viewerPersonId ?? activePerson;
  const { canSeeOthers, isPending: reachPending } = useViewerReach();
  const showPlanned = usePortalShowPlanned();
  const orgZonesVisible = canSeeOthers || reachPending;
  const { isAdmin } = useIsAdmin();

  const zones = ZONES.filter((z) => {
    if (zoneHidden(z.id) || (zoneIsPlanned(z) && !showPlanned)) return false;
    if (ZONES_FOR_EVERYONE.has(z.id)) return true;

    return orgZonesVisible || (z.id === "manage" && isAdmin);
  });

  function selectZone(zone: Zone, item?: string) {
    switch (zone.id) {
      case "person":
        if (me) go({ zone: "person", person: me, section: item });
        return;
      case "people":
        if (me) go({ zone: "people", person: me, item });
        return;
      case "directions":
        go({ zone: "directions" });
        return;
      case "custom":
        go({ zone: "custom" });
        return;
      case "overview":
      case "aicost":
      case "reports":
      case "manage":
        go({ zone: zone.id, item });
    }
  }

  return { zones, activeZone, me, selectZone };
}
