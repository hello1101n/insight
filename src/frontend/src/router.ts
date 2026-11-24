import { createRouter } from "@tanstack/react-router";

import { AppBootSpinner } from "@/components/app-boot-spinner";
import { CONTENT_ID } from "@/lib/portal/content-scroll";
import { servingBasepath } from "@/lib/base-path";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  basepath: servingBasepath(),
  defaultPreload: "intent",
  defaultPendingComponent: AppBootSpinner,
  defaultPendingMs: 200,
  scrollRestoration: true,
  scrollToTopSelectors: [`#${CONTENT_ID}`],
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
