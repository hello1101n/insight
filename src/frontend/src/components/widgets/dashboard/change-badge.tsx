import { TrendingDownIcon, TrendingUpIcon } from "lucide-react";

import type { ShownDelta } from "@/lib/metrics/delta";
import { STATUS_TEXT_CLASS } from "@/lib/status";
import { cn } from "@/lib/utils";

export function ChangeBadge({
  delta,
  since,
}: {
  delta: ShownDelta;
  since: string;
}) {
  return (
    <span
      className={cn("flex items-center gap-1", STATUS_TEXT_CLASS[delta.status])}
    >
      {delta.status === "neutral" ? null : delta.down ? (
        <TrendingDownIcon className="size-3.5" />
      ) : (
        <TrendingUpIcon className="size-3.5" />
      )}
      {delta.text} {since}
    </span>
  );
}
