import type { ComponentProps } from "react";

import { SidebarGroupLabel } from "@gears-frontx/ui-kit";
import { cn } from "@/lib/utils";

/** A pane group's heading, set as the design's uppercase eyebrow. */
export function PaneGroupLabel({
  className,
  ...props
}: ComponentProps<typeof SidebarGroupLabel>) {
  return (
    <SidebarGroupLabel
      className={cn(
        "items-end",
        className
      )}
      {...props}
    />
  );
}
