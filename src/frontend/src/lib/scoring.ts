import i18n from "@/i18n"
import type { PeerStatusWithNeutral } from "./peers"
import type { Status } from "./status"

export type RankedMetric<T> = {
  row: T
  rank: PeerStatusWithNeutral
}

export type RankCounts = {
  top: number
  inPack: number
  bottom: number
  unranked: number
}

export function rankCounts<T>(metrics: RankedMetric<T>[]): RankCounts {
  const c: RankCounts = { top: 0, inPack: 0, bottom: 0, unranked: 0 }
  for (const m of metrics) {
    if (m.rank === "top") c.top++
    else if (m.rank === "in_pack") c.inPack++
    else if (m.rank === "bottom") c.bottom++
    else c.unranked++
  }
  return c
}

export function rankableCount(counts: RankCounts): number {
  return counts.top + counts.inPack + counts.bottom
}

export function isRankable(rank: PeerStatusWithNeutral | null): boolean {
  return rank === "top" || rank === "in_pack" || rank === "bottom"
}

const SECTION_PATTERN_BAR = 0.25

export function gradeSectionStanding(counts: RankCounts): Status {
  const rankable = rankableCount(counts)
  if (rankable === 0) return "neutral"
  if (counts.bottom >= 2 && counts.bottom / rankable > SECTION_PATTERN_BAR)
    return "bad"
  if (counts.bottom >= 1) return "warn"
  if (counts.top >= 2 && counts.top / rankable > SECTION_PATTERN_BAR)
    return "good"
  return "neutral"
}

export function sectionStandingPhrase(counts: RankCounts): string {
  const rankable = rankableCount(counts)
  if (rankable === 0) return i18n.t("common.standing.no_comparison")
  if (counts.bottom > 0) {
    return i18n.t("common.standing.behind_peers", { count: counts.bottom, total: rankable })
  }
  if (counts.top > 0) {
    return i18n.t("common.standing.ahead_peers", { count: counts.top, total: rankable })
  }
  return i18n.t("common.standing.near_median")
}

