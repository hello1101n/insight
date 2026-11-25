import { useSidebar } from "@gears-frontx/ui-kit";
import { useShellLayout } from "@/lib/portal/use-shell-layout";

export function useDismissDrawer(): () => void {
  const layout = useShellLayout();
  const { setOpen, setOpenMobile } = useSidebar();
  return () => {
    if (layout === "phone") setOpenMobile(false);
    else if (layout === "narrow") setOpen(false);
  };
}
