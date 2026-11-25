import type { StoredMetric } from "@/api/custom-types";

const DEFAULT_WINDOW = "P7D";

export function takesWindow(stored: StoredMetric | undefined): boolean {
  return stored === undefined || Boolean(stored.clock);
}

export function windowFor(
  stored: StoredMetric | undefined,
  current: string
): string {
  if (stored === undefined) return current;
  if (!stored.clock) return "";

  return current === "" ? DEFAULT_WINDOW : current;
}
