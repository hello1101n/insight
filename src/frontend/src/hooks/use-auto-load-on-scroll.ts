import { useEffect, useRef, useState } from "react";

export function useAutoLoadOnScroll({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  root,
}: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
  root?: React.RefObject<HTMLElement | null>;
}): (node: HTMLElement | null) => void {
  const [marker, setMarker] = useState<HTMLElement | null>(null);
  const state = useRef({ hasNextPage, isFetchingNextPage, fetchNextPage });
  useEffect(() => {
    state.current = { hasNextPage, isFetchingNextPage, fetchNextPage };
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  useEffect(() => {
    if (marker === null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const { hasNextPage: more, isFetchingNextPage: busy, fetchNextPage: next } =
          state.current;
        if (!more || busy) return;
        next();
      },
      { root: root?.current ?? null, rootMargin: "200px" },
    );
    observer.observe(marker);
    return () => observer.disconnect();
    // INVARIANT: an observer reports only crossings; these deps re-observe so a
    // marker that a landed page left in view is read again.
  }, [marker, hasNextPage, isFetchingNextPage, root]);

  return setMarker;
}
