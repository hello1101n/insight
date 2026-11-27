import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import type { EditableKind } from "@/api/custom-client";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { definitionPagesQuery, type Narrowing } from "@/queries/custom";

const SEARCH_DEBOUNCE_MS = 400;

export function useDefinitionCatalogue<K extends EditableKind>(
  kind: K,
  { enabled = true, ...narrowing }: Narrowing & { enabled?: boolean } = {}
) {
  const [needle, setNeedle] = useState("");
  const searching = useDebouncedValue(needle, SEARCH_DEBOUNCE_MS).trim();
  const catalogue = useInfiniteQuery({
    ...definitionPagesQuery(kind, searching, narrowing),
    enabled,
  });
  const pages = catalogue.data?.pages;

  return {
    items: pages?.flatMap((page) => page.items),
    isLoading: catalogue.isLoading || !enabled,
    isError: catalogue.isError,
    refetch: () => void catalogue.refetch(),
    search: { value: needle, onChange: setNeedle },
    paging: {
      total: pages?.at(-1)?.total,
      hasMore: catalogue.hasNextPage,
      isFetchingMore: catalogue.isFetchingNextPage,
      onMore: () => void catalogue.fetchNextPage(),
      searching: searching !== "",
    },
  };
}
