import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Card, CardContent } from "@gears-frontx/ui-kit";
import type { AttentionItem } from "@/lib/insight/attention";
import type { GroupId } from "@/lib/insight/groups";
import { PEER_TEXT } from "@/lib/peers";
import { TEXT_EYEBROW, TEXT_LABEL, TEXT_NAME } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

const COLLAPSED_ATTENTION = 6;
const COLLAPSE_THRESHOLD = 7;

function findingBadge(item: AttentionItem): string {
  if (item.kind === "fell") {
    return item.direction === "lower_is_better"
      ? "rose this period"
      : "dropped this period";
  }
  return item.noPrevious
    ? "no earlier period to compare"
    : "not new this period";
}

export interface IcNeedsAttentionProps {
  items: AttentionItem[];
  onOpenGroup: (id: GroupId) => void;
  titled?: boolean;
}

export function IcNeedsAttention({
  items,
  onOpenGroup,
  titled = true,
}: IcNeedsAttentionProps) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);

  const attentionAll = items;

  if (attentionAll.length === 0) return null;

  const shouldCollapse = attentionAll.length >= COLLAPSE_THRESHOLD;
  const visible =
    !shouldCollapse || showAll
      ? attentionAll
      : attentionAll.slice(0, COLLAPSED_ATTENTION);

  return (
    <section>
      {titled ? (
        <h2 className={cn("mb-3", TEXT_EYEBROW)}>{t("worth_a_look.title")}</h2>
      ) : null}
      <Card size="sm">
        <CardContent>
          <ul className="flex flex-col gap-y-1 sm:grid sm:grid-cols-[minmax(0,max-content)_auto_auto_auto_minmax(0,1fr)_auto]">
            {visible.map((item) => (
              <li
                key={`${item.group}-${item.key}`}
                className="sm:col-span-full sm:grid sm:grid-cols-subgrid"
              >
                  <button
                    type="button"
                    onClick={() => onOpenGroup(item.group)}
                    className="-mx-2 flex w-[calc(100%+1rem)] flex-col gap-x-2 rounded px-2 py-1 text-left text-sm transition-colors hover:bg-muted sm:col-span-full sm:grid sm:w-auto sm:grid-cols-subgrid sm:items-baseline"
                  >
                    <span className="flex min-w-0 items-baseline gap-2 sm:contents">
                      <span
                        className={cn("min-w-0 truncate", TEXT_NAME)}
                        title={item.label}
                      >
                        {item.label}
                      </span>
                      <span className={cn("shrink-0 justify-self-start rounded border px-1.5 whitespace-nowrap", TEXT_LABEL)}>
                        {findingBadge(item)}
                      </span>
                    </span>
                    <span className="flex items-baseline gap-2 sm:contents">
                      <span
                        className={cn(
                          "text-right tabular-nums sm:justify-self-end",
                          PEER_TEXT.bottom
                        )}
                      >
                        {item.valueNumber}
                      </span>
                      <span
                        className={cn(
                          "text-left whitespace-nowrap",
                          PEER_TEXT.bottom
                        )}
                      >
                        {item.valueUnit}
                      </span>
                      <span className={cn("truncate whitespace-nowrap tabular-nums", TEXT_LABEL)}>
                        {item.medianText ? (
                          <>
                            {item.gapText ? <>{item.gapText} vs </> : null}
                            median {item.medianText}
                          </>
                        ) : null}
                      </span>
                    </span>
                    <ChevronRight
                      className="size-3.5 shrink-0 self-center text-muted-foreground"
                      aria-hidden
                    />
                  </button>
              </li>
            ))}
            {shouldCollapse ? (
              <li className="sm:col-span-full">
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className={cn(TEXT_LABEL, "rounded transition-colors hover:text-foreground")}
                >
                  {showAll
                    ? "Show fewer"
                    : `Show ${attentionAll.length - COLLAPSED_ATTENTION} more`}
                </button>
              </li>
            ) : null}
          </ul>
        </CardContent>
      </Card>
    </section>
  );
}
