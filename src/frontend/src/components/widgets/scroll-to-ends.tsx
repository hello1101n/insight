import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp } from "lucide-react";

import { Button } from "@gears-frontx/ui-kit";
import { cn } from "@/lib/utils";

export const SCROLL_ENDS_AFTER_ROWS = 25;

export function ScrollToEnds({
  scroller,
  rows,
  className,
}: {
  scroller: React.RefObject<HTMLElement | null>;
  rows: number;
  className?: string;
}) {
  const { t } = useTranslation();
  if (rows <= SCROLL_ENDS_AFTER_ROWS) return null;

  function jump(to: "top" | "bottom"): void {
    const node = scroller.current;
    if (node === null) return;
    node.scrollTo({
      top: to === "top" ? 0 : node.scrollHeight,
      behavior: "smooth",
    });
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute end-4 bottom-4 z-10 flex flex-col gap-1",
        className,
      )}
    >
      <Button
        type="button"
        variant="outline"
        className="pointer-events-auto"
        aria-label={t("common.actions.scroll_to_top")}
        onClick={() => jump("top")}
        icon={<ArrowUp className="size-4" />}
      />
      <Button
        type="button"
        variant="outline"
        className="pointer-events-auto"
        aria-label={t("common.actions.scroll_to_bottom")}
        onClick={() => jump("bottom")}
        icon={<ArrowDown className="size-4" />}
      />
    </div>
  );
}
