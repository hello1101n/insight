import { useLayoutEffect, useRef } from "react";

export function useHeightTransition(change: string | boolean | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const before = useRef<number | null>(null);
  const animation = useRef<Animation | null>(null);

  function captureHeight() {
    before.current = ref.current?.getBoundingClientRect().height ?? null;
  }

  useLayoutEffect(() => {
    const element = ref.current;
    const previousHeight = before.current;
    before.current = null;
    if (!element?.animate || previousHeight == null) return;

    animation.current?.cancel();
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const height = element.getBoundingClientRect().height;
    if (height !== previousHeight)
      animation.current = element.animate(
        [
          { height: `${previousHeight}px`, overflow: "clip" },
          { height: `${height}px`, overflow: "clip" },
        ],
        { duration: 240, easing: "ease-in-out" }
      );
  }, [change]);

  return [ref, captureHeight] as const;
}
