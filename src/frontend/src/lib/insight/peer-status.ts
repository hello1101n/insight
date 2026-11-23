import type { PeerStatusWithNeutral } from "@/lib/peers";
import type { Status } from "@/lib/status";

export function peerStatusToStatus(p: PeerStatusWithNeutral): Status {
  if (p === "top") return "good";
  if (p === "bottom") return "bad";
  return "neutral";
}
