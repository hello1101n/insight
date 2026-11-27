import {
  forEntity,
  type NormalizedMetricResult,
} from "@/lib/metrics/collection";

export function typicalPeerPool(
  byKey: Map<string, NormalizedMetricResult>,
  entityId: string,
): number | null {
  const counts = new Map<number, number>();
  for (const metric of byKey.values()) {
    const n = forEntity(metric, entityId).peer?.n;
    if (typeof n !== "number" || n <= 0) continue;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  let best: { n: number; seen: number } | null = null;
  for (const [n, seen] of counts) {
    if (!best || seen > best.seen || (seen === best.seen && n > best.n)) {
      best = { n, seen };
    }
  }
  return best?.n ?? null;
}
