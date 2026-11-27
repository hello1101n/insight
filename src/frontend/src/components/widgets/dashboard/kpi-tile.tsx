import { ChevronRight, Sparkles } from "lucide-react";

import { ChangeBadge } from "@/components/widgets/dashboard/change-badge";
import { Sparkline } from "@/components/widgets/dashboard/sparkline";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@gears-frontx/ui-kit";
import type { KpiTileData } from "@/lib/insight/kpi-row";
import type { GroupId } from "@/lib/insight/groups";
import { TEXT_FIGURE } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

export interface KpiTileProps {
  tile: KpiTileData;
  periodNoun: string;
  trend?: (number | null)[] | null;
  onOpenGroup?: (id: GroupId) => void;
}

const CARD_SURFACE = "@container/card";

export function KpiTile({
  tile,
  periodNoun,
  trend,
  onOpenGroup,
}: KpiTileProps) {
  const primaryGroup = onOpenGroup ? tile.groupId : null;
  const interactive = primaryGroup != null;

  return (
    <Card
      className={cn(CARD_SURFACE, "relative", interactive && "text-left")}
      render={
        primaryGroup ? (
          <button
            type="button"
            onClick={() => onOpenGroup?.(primaryGroup)}
            aria-label={`Open ${tile.label} details`}
          />
        ) : undefined
      }
    >
      {interactive ? (
        <ChevronRight
          className="absolute right-3 bottom-3 size-3.5 text-muted-foreground"
          aria-hidden
        />
      ) : null}
      <CardHeader>
        <CardDescription className="min-w-0 truncate" title={tile.label}>
          {tile.label}
        </CardDescription>
        <CardTitle className="col-span-full flex w-full flex-wrap items-baseline justify-between gap-x-2 gap-y-1 tabular-nums">
          <span className={TEXT_FIGURE}>{tile.value}</span>
          {trend ? <Sparkline points={trend} className="self-center" /> : null}
        </CardTitle>
      </CardHeader>
      <CardFooter className="mt-auto min-h-[2lh] flex-col items-start">
        {tile.delta ? (
          <ChangeBadge delta={tile.delta} since={`since last ${periodNoun}`} />
        ) : (
          <span>no earlier {periodNoun} to compare</span>
        )}
        <span>
          {tile.medianLabel
            ? `Team ${tile.medianLabel}${tile.gapText ? ` · ${tile.gapText}` : ""}`
            : "No comparison"}
        </span>
        {tile.absenceLabel ? <span>{tile.absenceLabel}</span> : null}
      </CardFooter>
    </Card>
  );
}

export function KpiTilePlaceholder({ label }: { label?: string }) {
  return (
    <Card className={CARD_SURFACE}>
      <CardHeader>
        <CardDescription className="min-w-0 truncate">
          {label ?? " "}
        </CardDescription>
        <CardTitle>
          <span className={TEXT_FIGURE}>—</span>
        </CardTitle>
      </CardHeader>
      <CardFooter>
        <Sparkles className="size-3.5 shrink-0" aria-hidden />
        Coming soon
      </CardFooter>
    </Card>
  );
}
