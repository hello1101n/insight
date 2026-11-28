import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Navigate, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ViewAsBanner } from "@/components/view-as-banner";
import { ContextPane, ZonePages } from "@/components/portal/context-pane";
import {
  LensRail,
  RailFooterItems,
  RailItems,
} from "@/components/portal/lens-rail";
import { PortalTopBar } from "@/components/portal/portal-topbar";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarProvider,
  TooltipProvider,
  useSidebar,
} from "@gears-frontx/ui-kit";
import { useMetricsViewHidesPane } from "@/lib/portal/metrics-view-pane";
import { PortalDocumentTitle } from "@/lib/portal/document-title-frame";
import { bareLandingZone, landingDecision } from "@/lib/portal/landing-zone";
import {
  usePortalRailLabels,
  usePortalShowPlanned,
} from "@/lib/portal/portal-store";
import {
  useShellLayout,
  type ShellLayout,
} from "@/lib/portal/use-shell-layout";
import { CONTENT_ID } from "@/lib/portal/content-scroll";
import { useNavLocation } from "@/lib/portal/use-nav-location";
import { useViewerReach } from "@/lib/portal/use-viewer-reach";
import { useZoneNav } from "@/lib/portal/use-zone-nav";
import { TOOLTIP_DELAY_MS } from "@/lib/tooltip-delay";
import { useIsAdmin } from "@/queries/identity-me";

export function PortalLayout() {
  const paneHidden = useMetricsViewHidesPane();
  const railWidth = usePortalRailLabels() ? RAIL_WIDTH_LABELS : RAIL_WIDTH_ICONS;

  return (
    <PortalDocumentTitle>
      <SidebarProvider
        className="h-svh overflow-hidden"
        style={
          {
            "--rail-width": railWidth,
            "--sidebar-width": paneHidden
              ? railWidth
              : `calc(${railWidth} + ${PANE_WIDTH})`,
          } as CSSProperties
        }
      >
        <PaneStateForLayout />
        <ShellSidebar />
        <SidebarInset
          id={CONTENT_ID}
          data-scroll-restoration-id={CONTENT_ID}
          className="isolate min-w-0 overflow-x-clip overflow-y-auto"
        >
          {/* WORKAROUND: the kit's SidebarProvider sets a tooltip delay of 0
              for everything inside it, sidebar or not. */}
          <TooltipProvider delay={TOOLTIP_DELAY_MS}>
            <ViewAsBanner />
            <PortalTopBar />
            <ZoneGuard>
              <Outlet />
            </ZoneGuard>
          </TooltipProvider>
        </SidebarInset>
      </SidebarProvider>
    </PortalDocumentTitle>
  );
}

const RAIL_WIDTH_ICONS = "calc(var(--sidebar-width-icon) + 1px)";
const RAIL_WIDTH_LABELS = "12rem";
const PANE_WIDTH = "16rem";

export function ShellSidebar() {
  const { isMobile } = useSidebar();

  return (
    <Sidebar
      collapsible="icon"
      className={
        // WORKAROUND: the kit's phone drawer is a Sheet, whose 24px inset pads
        // the sidebar inside it; the sidebar's rows carry their own spacing.
        "overflow-hidden md:*:flex-row [--sheet-inset:0]"
      }
    >
      {isMobile ? (
        <PhoneDrawer />
      ) : (
        <>
          <LensRail />
          <ContextPane />
        </>
      )}
    </Sidebar>
  );
}

function PhoneDrawer() {
  const { t } = useTranslation();
  const nav = useZoneNav();

  return (
    <>
      <SidebarContent>
        <RailItems />
        <div
          role="navigation"
          aria-label={t("common.a11y.section_navigation")}
          className="contents"
        >
          <ZonePages nav={nav} />
        </div>
      </SidebarContent>
      <SidebarFooter>
        <RailFooterItems />
      </SidebarFooter>
    </>
  );
}

// WORKAROUND: the kit's `open` defaults to true and survives a resize, and its `setOpen`
// changes on every toggle, so the pane state resets only when the layout changes.
function PaneStateForLayout() {
  const layout = useShellLayout();
  const { setOpen } = useSidebar();
  const previous = useRef<ShellLayout | null>(null);
  useEffect(() => {
    if (previous.current === layout) return;
    previous.current = layout;
    setOpen(layout === "wide");
  }, [layout, setOpen]);
  return null;
}

function ZoneGuard({ children }: { children: ReactNode }) {
  const { zone } = useNavLocation();
  const { canSeeOthers, isPending } = useViewerReach();
  const { isAdmin, isPending: adminPending, isError: adminError } = useIsAdmin();
  const adminUnknown = adminPending || adminError;
  const homeShown = bareLandingZone(usePortalShowPlanned()) === "overview";
  const decision = landingDecision({
    zone,
    mgrPending: isPending,
    canSeeOthers,
    adminPending: adminUnknown,
    isAdmin,
    homeShown,
  });

  if (decision.kind === "reset") return <Navigate to="/" search replace />;
  return children;
}
