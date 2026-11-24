import { ChevronsLeft, ChevronsRight, MessageSquare, Settings } from "lucide-react";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import brandSymbol from "@/assets/brand-symbol.svg";

import { AppSidebarFooter } from "@/components/app-sidebar-footer";
import { useFeedbackDialog } from "@/components/feedback-context";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useSidebar,
} from "@gears-frontx/ui-kit";
import { resolveText } from "@/i18n/localized-text";
import {
  setPortalRailLabels,
  usePortalRailLabels,
} from "@/lib/portal/portal-store";
import { useRailNav } from "@/lib/portal/use-rail-nav";
import { cn } from "@/lib/utils";

export function LensRail() {
  const { t } = useTranslation();
  return (
    <Sidebar
      collapsible="none"
      data-testid="lens-rail"
      className="w-(--rail-width) border-e transition-[width] duration-200 ease-linear motion-reduce:transition-none"
    >
      <SidebarHeader>
        <img
          src={brandSymbol}
          alt={t("nav.brand_alt")}
          className="size-8 shrink-0"
          width={32}
          height={32}
        />
      </SidebarHeader>
      <SidebarContent>
        <RailItems />
      </SidebarContent>
      <SidebarFooter>
        <RailFooterItems />
        <SidebarMenu>
          <LabelsToggle />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function useRailLabelsShown(): boolean {
  const labels = usePortalRailLabels();
  const { isMobile, state } = useSidebar();
  return isMobile || (labels && state === "expanded");
}

function RailName({ children }: { children: string }) {
  const shown = useRailLabelsShown();
  return (
    <span
      className={cn(
        "transition-opacity duration-150 motion-reduce:transition-none",
        shown ? "opacity-100 delay-200" : "opacity-0"
      )}
    >
      {children}
    </span>
  );
}

function LabelsToggle() {
  const { t } = useTranslation();
  const labels = usePortalRailLabels();
  const { state } = useSidebar();

  if (state === "collapsed") return null;

  const label = labels
    ? t("common.a11y.collapse_navigation")
    : t("common.a11y.expand_navigation");
  const Icon = labels ? ChevronsLeft : ChevronsRight;
  return (
    <SidebarMenuItem className="flex justify-end">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon />}
              aria-label={label}
              onClick={() => setPortalRailLabels(!labels)}
            />
          }
        />
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export function RailItems() {
  const { t } = useTranslation();
  const { items, activeItem, selectItem } = useRailNav();
  const { setOpen } = useSidebar();

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => {
            const label = resolveText(t, item.label);
            return (
            <SidebarMenuItem key={item.id}>
              <RailTooltip label={label}>
                <SidebarMenuButton
                  aria-label={label}
                  data-planned={item.planned || undefined}
                  isActive={activeItem === item.id}
                  onClick={() => {
                    selectItem(item);
                    setOpen(true);
                  }}
                >
                  <item.icon />
                  <RailName>{label}</RailName>
                </SidebarMenuButton>
              </RailTooltip>
            </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export function RailFooterItems() {
  return (
    <SidebarMenu>
      <FeedbackItem />
      <SettingsItem />
    </SidebarMenu>
  );
}

function FeedbackItem() {
  const { t } = useTranslation();
  const feedback = useFeedbackDialog();
  const { setOpenMobile } = useSidebar();

  if (!feedback) return null;

  const label = t("feedback.nav_label");
  return (
    <SidebarMenuItem>
      <RailTooltip label={label}>
        <SidebarMenuButton
          aria-label={label}
          onClick={() => {
            feedback.openFeedback();
            setOpenMobile(false);
          }}
        >
          <MessageSquare />
          <RailName>{label}</RailName>
        </SidebarMenuButton>
      </RailTooltip>
    </SidebarMenuItem>
  );
}

function SettingsItem() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { isMobile, setOpenMobile } = useSidebar();
  const label = t("settings.nav_label");

  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={setOpen}>
        <RailTooltip label={label}>
          <PopoverTrigger
            render={
              <SidebarMenuButton aria-label={label}>
                <Settings />
                <RailName>{label}</RailName>
              </SidebarMenuButton>
            }
          />
        </RailTooltip>
        <PopoverContent
          side={isMobile ? "top" : "right"}
          align={isMobile ? "start" : "end"}
          className="w-64"
        >
          <AppSidebarFooter
            showFeedback={false}
            onNavigate={() => {
              setOpen(false);
              setOpenMobile(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}

// WORKAROUND: the kit's `tooltip` prop shows only while the whole sidebar is collapsed.
function RailTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}) {
  const labelsShown = useRailLabelsShown();
  if (labelsShown) return children;

  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
