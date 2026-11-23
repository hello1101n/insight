import {
  ZONES_FOR_EVERYONE,
  zoneById,
  zoneIsPlanned,
} from "@/lib/portal/nav-model";
import {
  navPolicy,
  zoneHidden,
  type InstanceNavPolicy,
} from "@/lib/portal/nav-policy";

export type LandingDecision =
  { kind: "wait" } | { kind: "keep" } | { kind: "reset" };

export function landingDecision(args: {
  zone: string | null;
  mgrPending: boolean;
  canSeeOthers: boolean;
  adminPending: boolean;
  isAdmin: boolean;
  homeShown: boolean;
}): LandingDecision {
  const { zone, mgrPending, canSeeOthers, adminPending, isAdmin, homeShown } =
    args;

  if (zone === "overview" && !homeShown) return { kind: "reset" };
  if (zone == null || ZONES_FOR_EVERYONE.has(zone)) return { kind: "keep" };
  if (mgrPending) return { kind: "wait" };
  if (canSeeOthers) return { kind: "keep" };

  if (zone === "manage") {
    if (adminPending) return { kind: "wait" };
    return isAdmin ? { kind: "keep" } : { kind: "reset" };
  }
  return { kind: "reset" };
}

export function bareLandingZone(
  showPlanned: boolean,
  policy: InstanceNavPolicy = navPolicy()
): "overview" | "person" {
  const home = zoneById("overview");
  const homeShown =
    home !== undefined &&
    !zoneHidden(home.id, policy) &&
    (!zoneIsPlanned(home, policy) || showPlanned);
  return homeShown ? "overview" : "person";
}
