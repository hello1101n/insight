import type { DashboardWidget, RunOptions } from "@/api/custom-client";

import { drawsBucket } from "./draws-bucket";
import { isRangeToken, toInterval } from "./time-range";

export function selectedRange(
  offered: string[] | undefined,
  fallback: string | undefined,
  fromUrl: string | undefined,
): string | undefined {
  if (!offered || offered.length === 0) return undefined;

  const usable = (token: string | undefined): token is string =>
    typeof token === "string" &&
    isRangeToken(token) &&
    (offered.includes(token) || toInterval(token) !== undefined);

  if (usable(fromUrl)) return fromUrl;
  if (usable(fallback)) return fallback;

  return offered[0];
}

export function runOptions(
  widget: DashboardWidget,
  range: string | undefined,
): RunOptions | undefined {
  return range && widget.clock
    ? { range, bucket: drawsBucket(widget.body) }
    : undefined;
}
