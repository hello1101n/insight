export type PeerStats = {
  p25: number
  p50: number
  p75: number
  min: number
  max: number
  n: number
}

export type PeerStatus = "top" | "in_pack" | "bottom"
export type PeerStatusWithNeutral = PeerStatus | "neutral"

export type PeerCohortLabel = "team" | "org" | "department" | (string & {})

export const PEER_CELL: Record<PeerStatusWithNeutral, string> = {
  top: "bg-success/30 text-foreground",
  bottom: "bg-destructive/20 text-foreground",
  in_pack: "bg-secondary text-secondary-foreground",
  neutral: "bg-muted text-muted-foreground",
}

export const PEER_TEXT: Record<PeerStatusWithNeutral, string> = {
  top: "text-success",
  bottom: "text-destructive",
  in_pack: "text-foreground",
  neutral: "text-muted-foreground",
}

export const PEER_LABEL: Record<PeerStatusWithNeutral, string> = {
  top: "Top 25%",
  in_pack: "Near the median",
  bottom: "Bottom 25%",
  neutral: "No comparison",
}

export const PEER_FILL: Record<PeerStatusWithNeutral, string> = {
  top: "bg-success",
  bottom: "bg-destructive",
  in_pack: "bg-muted-foreground/40",
  neutral: "bg-muted-foreground/20",
}

export function peerStatusVsQuartiles(
  value: number,
  stats: Pick<PeerStats, "p25" | "p50" | "p75">,
  higherIsBetter: boolean
): PeerStatus {
  if (higherIsBetter) {
    if (value >= stats.p75 && value > stats.p50) return "top"
    if (value <= stats.p25 && value < stats.p50) return "bottom"
    return "in_pack"
  }
  if (value <= stats.p25 && value < stats.p50) return "top"
  if (value >= stats.p75 && value > stats.p50) return "bottom"
  return "in_pack"
}
