import { TooltipProvider } from "@gears-frontx/ui-kit";
import { createElement, type ReactNode } from "react";

export function AppTooltips({ children }: { children: ReactNode }) {
  return createElement(TooltipProvider, { delay: 0 }, children);
}

// WORKAROUND: the kit marks positioner, popup and arrow alike with `data-side`;
// the popup is the child that is neither the hidden arrow nor a role-bearing menu.
export function openTooltip(): Element | null {
  const marked = [...document.querySelectorAll("[data-open][data-side]")];
  return (
    marked.find(
      (element) =>
        element.parentElement?.hasAttribute("data-side") === true &&
        !element.hasAttribute("aria-hidden") &&
        !element.hasAttribute("role")
    ) ?? null
  );
}
