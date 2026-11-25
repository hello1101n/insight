import type { AnyRouter } from "@tanstack/react-router";

import { recordPageView } from "@/telemetry";

export function recordScreens(router: Pick<AnyRouter, "subscribe">): void {
  let recorded: string | null = null;
  router.subscribe("onResolved", ({ toLocation }) => {
    const screen = toLocation.pathname;
    if (screen === recorded) return;
    recorded = screen;
    recordPageView(screen);
  });
}
