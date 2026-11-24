import { useTranslation } from "react-i18next";

import { CustomNav, HomeDashboardsGroup } from "@/components/portal/custom-nav";
import { ExploreNav } from "@/components/portal/explore-nav";
import { GroupsNav } from "@/components/portal/pane-nav";
import { PeopleNav } from "@/components/portal/people-nav";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  useSidebar,
} from "@gears-frontx/ui-kit";
import {
  manageGroupsFor,
  resolveZoneItem,
  zoneSections,
} from "@/lib/portal/nav-model";
import { useMetricsViewHidesPane } from "@/lib/portal/metrics-view-pane";
import { useNavLocation } from "@/lib/portal/use-nav-location";
import { railItemFor, type RailId } from "@/lib/portal/rail-model";
import { useZoneNav, type ZoneNav } from "@/lib/portal/use-zone-nav";
import {
  homeItemShown,
  useHomeSubject,
  type HomeSubject,
} from "@/lib/portal/home-subject";
import { resolveText } from "@/i18n/localized-text";
import { useIsAdmin } from "@/queries/identity-me";
import { usePreviewsGate } from "@/queries/previews";

export function ContextPane() {
  const nav = useZoneNav();
  const rail = railItemFor(nav.activeZone);
  const { t } = useTranslation();
  const { state } = useSidebar();
  const hidden = useMetricsViewHidesPane();

  if (hidden) return null;

  return (
    <Sidebar
      collapsible="none"
      className="min-w-0 flex-1"
      // WORKAROUND: the kit only clips a collapsed pane; it stays in the Tab order.
      inert={state === "collapsed"}
    >
      <SidebarHeader>
        <span className="px-2 py-1.5 text-sm font-semibold tracking-tight text-sidebar-foreground">
          {rail ? resolveText(t, rail.paneTitle ?? rail.label) : t("nav.insight")}
        </span>
      </SidebarHeader>
      <SidebarContent
        role="navigation"
        aria-label={t("common.a11y.section_navigation")}
      >
        <ZonePages nav={nav} />
      </SidebarContent>
    </Sidebar>
  );
}

export function ZonePages({ nav }: { nav: ZoneNav }) {
  const rail = railItemFor(nav.activeZone);
  return rail ? <RailPane rail={rail.id} nav={nav} /> : null;
}

function RailPane({ rail, nav }: { rail: RailId; nav: ZoneNav }) {
  const active = resolveZoneItem(nav.activeZone, useNavLocation().item);
  const visibleZones = new Set(nav.zones.map((zone) => zone.id));
  const { subject, isPending: reachPending } = useHomeSubject();

  switch (rail) {
    case "home":
      return (
        <>
          {reachPending ? null : (
            <GroupsNav groups={homeGroupsFor(subject)} active={active} />
          )}
          {visibleZones.has("custom") ? <HomeDashboardsGroup /> : null}
        </>
      );
    case "dashboards":
      return <CustomNav />;
    case "explore":
      return <ExploreNav visibleZones={visibleZones} />;
    case "people":
      return <PeopleNav nav={nav} />;
    case "reports":
      return <GroupsNav groups={zoneSections("reports")} active={active} />;
    case "manage":
      return <ManageNav active={active} />;
  }
}

function homeGroupsFor(subject: HomeSubject) {
  return zoneSections("overview").map((group) => ({
    ...group,
    items: group.items.filter((item) => homeItemShown(subject, item.id)),
  }));
}

function ManageNav({ active }: { active: string | null }) {
  const { isAdmin } = useIsAdmin();
  const canManagePreviews = usePreviewsGate();
  return (
    <GroupsNav groups={manageGroupsFor({ isAdmin, canManagePreviews })} active={active} />
  );
}
