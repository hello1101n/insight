import { Spinner } from "@gears-frontx/ui-kit";
import { useAutoLoadOnScroll } from "@/hooks/use-auto-load-on-scroll";
import { TEXT_LABEL } from "@/lib/type-scale";
import { cn } from "@/lib/utils";

export interface Paging {
  total: number | undefined;
  hasMore: boolean;
  isFetchingMore: boolean;
  onMore: () => void;
  searching: boolean;
}

export function DefinitionCount({
  total,
  noun,
  searching,
}: {
  total: number | undefined;
  noun: string;
  searching: boolean;
}) {
  if (total === undefined) {
    return null;
  }

  return (
    <p className={cn(TEXT_LABEL, "shrink-0 text-muted-foreground")}>
      {searching
        ? `${total} matching`
        : `${total} ${total === 1 ? noun.replace(/s$/, "") : noun}`}
    </p>
  );
}

export function MoreDefinitions({
  hasMore,
  isFetchingMore,
  onMore,
}: Omit<Paging, "total" | "searching">) {
  const marker = useAutoLoadOnScroll({
    hasNextPage: hasMore,
    isFetchingNextPage: isFetchingMore,
    fetchNextPage: onMore,
  });

  return (
    <div ref={marker} className="mt-4 flex min-h-4 justify-center">
      {isFetchingMore ? <Spinner /> : null}
    </div>
  );
}
