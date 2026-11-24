import {
  Activity,
  BarChart3,
  BookOpen,
  Bot,
  Clock,
  Copy,
  DollarSign,
  Eye,
  FileSpreadsheet,
  FileText,
  Filter,
  Database,
  Fingerprint,
  FlaskConical,
  GitPullRequest,
  LayoutGrid,
  Layers,
  List,
  Lock,
  Megaphone,
  MessageSquare,
  Plug,
  Radar,
  Server,
  Settings2,
  Share2,
  Sparkles,
  Star,
  Table2,
  Ticket,
  TrendingUp,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { DisplayText } from "@/i18n/localized-text";

import {
  itemHidden,
  EMPTY_NAV_POLICY,
  itemPlanned,
  navPolicy,
  zonePlanned,
  type InstanceNavPolicy,
} from "./nav-policy";


export type ZoneKind =
  | "person"
  | "directions"
  | "theme"
  | "manage"
  | "people"
  | "custom";

export type Readiness = "planned";

export interface Zone {
  id: string;
  label: DisplayText;
  kind: ZoneKind;
}

export const ZONES: readonly Zone[] = [
  { id: "overview", label: { key: "nav.zones.overview" }, kind: "theme" },
  { id: "directions", label: { key: "nav.zones.directions" }, kind: "directions" },
  { id: "person", label: { key: "nav.zones.person" }, kind: "person" },
  { id: "people", label: { key: "nav.zones.people" }, kind: "people" },
  { id: "aicost", label: { key: "nav.zones.aicost" }, kind: "theme" },
  { id: "reports", label: { key: "nav.zones.reports" }, kind: "theme" },
  { id: "custom", label: { key: "nav.zones.custom" }, kind: "custom" },
  { id: "manage", label: { key: "nav.zones.manage" }, kind: "manage" },
];

export const ZONES_FOR_EVERYONE: ReadonlySet<string> = new Set([
  "overview",
  "person",
  "reports",
  "custom",
]);

export function zoneIsPlanned(zone: Zone, policy: InstanceNavPolicy = navPolicy()): boolean {
  const items = zoneItems(zone.id);
  return (
    zonePlanned(zone.id, policy) ||
    (items.length > 0 && items.every((item) => item.unbuilt))
  );
}

export function lensSlug(lens: string): string {
  return lens
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function lensBySlug(direction: Direction, slug: string): string | undefined {
  return direction.lenses.find((lens) => lensSlug(lens) === slug);
}

export function zoneById(id: string | null): Zone | undefined {
  if (!id) return undefined;
  return ZONES.find((z) => z.id === id);
}

export type DirectionSource = "semantic" | "bullet";

export interface Direction {
  id: string;
  name: DisplayText;
  icon: LucideIcon;
  source: DirectionSource;
  lenses: readonly string[];
}

export const DIRECTIONS: readonly Direction[] = [
  {
    id: "dev",
    name: { key: "nav.directions.dev" },
    icon: GitPullRequest,
    source: "semantic",
    lenses: [
      "Overview",
      "Git output",
      "Work in flight",
      "Delivery",
      "Activity",
      "Flow",
      "Quality",
      "CI",
      "Continuity",
      "Repositories",
      "Elements",
    ],
  },
  {
    id: "collab",
    name: { key: "nav.directions.collab" },
    icon: MessageSquare,
    source: "semantic",
    lenses: ["Overview", "Messaging", "Meetings", "Email", "Time outside meetings", "Files & sharing"],
  },
  {
    id: "wiki",
    name: { key: "nav.directions.wiki" },
    icon: BookOpen,
    source: "semantic",
    lenses: ["Overview", "Authoring", "Edits & comments", "Active authors"],
  },
  {
    id: "sales",
    name: { key: "nav.directions.sales" },
    icon: DollarSign,
    source: "bullet",
    lenses: ["Pipeline", "Deal flow", "Activity", "Velocity & quality"],
  },
  {
    id: "support",
    name: { key: "nav.directions.support" },
    icon: Ticket,
    source: "bullet",
    lenses: ["Tickets", "CSAT", "Knowledge base", "Comments & updates"],
  },
];

export interface PaneItem {
  id: string;
  label: DisplayText;
  icon: LucideIcon;
  badge?: { text: string; tone: "warn" | "new" | "error" };
  readiness?: Readiness;
  adminOnly?: boolean;
  previewsGated?: boolean;
  unbuilt?: boolean;
}

export interface PaneGroup {
  label?: DisplayText;
  icon?: LucideIcon;
  items: readonly PaneItem[];
}

export const PLANNED_GROUP_LABEL: DisplayText = { key: "nav.groups.planned" };

export function partitionByReadiness<
  T extends { readiness?: Readiness; unbuilt?: boolean },
>(entries: readonly T[], showPlanned: boolean): { live: T[]; planned: T[] } {
  const live: T[] = [];
  const planned: T[] = [];
  for (const e of entries) {
    if (e.unbuilt) {
      if (showPlanned) live.push(e);
    } else if (e.readiness == null) live.push(e);
    else if (showPlanned) planned.push(e);
  }
  return { live, planned };
}

export function orderByReadiness<
  T extends { readiness?: Readiness; unbuilt?: boolean },
>(entries: readonly T[], showPlanned: boolean): T[] {
  const { live, planned } = partitionByReadiness(entries, showPlanned);
  return [...live, ...planned];
}

function withConfigReadiness(
  zoneId: string,
  item: PaneItem,
  policy: InstanceNavPolicy,
): PaneItem {
  if (!itemPlanned(zoneId, item.id, policy)) return item;
  return { ...item, readiness: "planned" };
}

export function zoneSections(
  zoneId: string,
  policy: InstanceNavPolicy = navPolicy(),
): readonly PaneGroup[] {
  return (ZONE_SECTIONS[zoneId] ?? [])
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => !itemHidden(zoneId, item.id, policy))
        .map((item) => withConfigReadiness(zoneId, item, policy)),
    }))
    .filter((group) => group.items.length > 0);
}

export const ZONE_SECTIONS: Record<string, readonly PaneGroup[]> = {
  overview: [
    {
      label: { key: "nav.groups.themes" },
      items: [
        { id: "at-a-glance", label: { key: "nav.items.at_a_glance" }, icon: LayoutGrid },
        { id: "by-direction", label: { key: "nav.items.by_direction" }, icon: Layers },
        { id: "attention", label: { key: "worth_a_look.title" }, icon: Eye },
      ],
    },
  ],
  aicost: [
    {
      items: [{ id: "overview", label: { key: "nav.items.overview" }, icon: LayoutGrid }],
    },
    {
      label: { key: "common.sections.ai_adoption" },
      icon: Bot,
      items: [
        { id: "adoption-funnel", label: { key: "nav.items.adoption_funnel" }, icon: Activity },
        { id: "by-unit-role", label: { key: "nav.items.by_unit_role" }, icon: Layers },
        { id: "per-tool", label: { key: "nav.items.per_tool" }, icon: Sparkles },
        { id: "autofix", label: { key: "nav.items.autofix" }, icon: Activity },
        { id: "ai-audit", label: { key: "nav.items.ai_audit" }, icon: Radar },
      ],
    },
    {
      label: { key: "nav.groups.cost" },
      icon: DollarSign,
      items: [
        { id: "spend-by-tool", label: { key: "nav.items.spend_by_tool" }, icon: DollarSign },
        { id: "cost-by-unit", label: { key: "nav.items.cost_by_unit" }, icon: Users },
        { id: "idle-seats", label: { key: "nav.items.idle_seats" }, icon: Clock },
        { id: "credits", label: { key: "nav.items.credits" }, icon: TrendingUp },
        {
          id: "ai-pricing",
          label: { key: "nav.items.ai_pricing" },
          icon: DollarSign,
          badge: { text: "ai.cost", tone: "error" },
        },
      ],
    },
  ],
  reports: [
    {
      items: [{ id: "report-builder", label: { key: "nav.items.report_builder" }, icon: FileSpreadsheet }],
    },
    {
      label: PLANNED_GROUP_LABEL,
      items: [
        { id: "snapshots", label: { key: "nav.items.snapshots" }, icon: FileText, unbuilt: true },
        { id: "export", label: { key: "nav.items.export_pdf" }, icon: Share2, unbuilt: true },
        { id: "templates", label: { key: "nav.items.templates" }, icon: Copy, unbuilt: true },
      ],
    },
  ],
};

export const DASHBOARD_BROWSE_PLANNED: readonly PaneItem[] = [
  { id: "starred", label: { key: "nav.items.starred" }, icon: Star, unbuilt: true },
  { id: "starter", label: { key: "nav.items.starter" }, icon: Sparkles, unbuilt: true },
];

export const STARTER_DASHBOARDS: PaneItem = {
  id: "starter-dashboards",
  label: { key: "nav.items.starter_dashboards" },
  icon: Sparkles,
  unbuilt: true,
};

type PeopleItems = readonly [
  PaneItem & { id: "roster" },
  PaneItem & { id: "employees" },
  PaneItem & { id: "metrics" },
];

export const PEOPLE_ITEMS: PeopleItems = [
  { id: "roster", label: { key: "nav.items.my_team" }, icon: Users },
  { id: "employees", label: { key: "nav.items.roster_by_role" }, icon: List },
  { id: "metrics", label: { key: "nav.items.metrics_view" }, icon: Table2 },
];

const FLAT_PEOPLE_ITEMS: PeopleItems = [
  { id: "roster", label: { key: "nav.items.overview" }, icon: LayoutGrid },
  { id: "employees", label: { key: "nav.items.roster" }, icon: Users },
  { id: "metrics", label: { key: "nav.items.metrics_view" }, icon: Table2 },
];

export function peopleItemsFor(
  isFlat: boolean,
  policy: InstanceNavPolicy = navPolicy()
): readonly PaneItem[] {
  const items = isFlat ? FLAT_PEOPLE_ITEMS : PEOPLE_ITEMS;
  return items
    .filter((item) => !itemHidden("people", item.id, policy))
    .map((item) => withConfigReadiness("people", item, policy));
}

export interface ManageGates {
  isAdmin: boolean;
  canManagePreviews: boolean;
}

export function manageGroupsFor(
  gates: ManageGates,
  policy: InstanceNavPolicy = navPolicy(),
): readonly PaneGroup[] {
  return MANAGE_GROUPS.map((group) => ({
    ...group,
    items: group.items
      .filter(
        (item) =>
          (!item.adminOnly || gates.isAdmin) &&
          (!item.previewsGated || gates.canManagePreviews) &&
          !itemHidden("manage", item.id, policy),
      )
      .map((item) => withConfigReadiness("manage", item, policy)),
  })).filter((group) => group.items.length > 0);
}

export function manageLandingItem(
  gates: ManageGates,
  policy: InstanceNavPolicy = navPolicy(),
): string | null {
  return (
    manageGroupsFor(gates, policy)
      .flatMap((group) => group.items)
      .find((item) => !item.unbuilt && item.readiness == null)?.id ?? null
  );
}

export const MANAGE_GROUPS: readonly PaneGroup[] = [
  {
    label: { key: "nav.groups.data" },
    items: [
      {
        id: "connector-health",
        label: { key: "nav.items.connectors" },
        icon: Plug,
        adminOnly: true,
      },
      { id: "exclusions", label: { key: "nav.items.data_exclusions" }, icon: Filter, unbuilt: true },
      { id: "snapshots", label: { key: "nav.items.org_snapshots" }, icon: Clock, unbuilt: true },
    ],
  },
  {
    label: { key: "nav.groups.people_access" },
    items: [
      {
        id: "identities",
        label: { key: "nav.items.identities" },
        icon: Fingerprint,
        adminOnly: true,
      },
      { id: "access", label: { key: "nav.items.access" }, icon: Lock, unbuilt: true },
      { id: "group-mgmt", label: { key: "nav.items.group_mgmt" }, icon: Users, unbuilt: true },
    ],
  },
  {
    label: { key: "nav.groups.platform" },
    items: [
      { id: "ingestion", label: { key: "nav.items.ingestion" }, icon: Database, adminOnly: true },
      { id: "previews", label: { key: "nav.items.previews" }, icon: FlaskConical, previewsGated: true },
      { id: "ai-assistant", label: { key: "nav.items.ai_assistant" }, icon: Sparkles },
      { id: "whats-new", label: { key: "whats_new.nav_label" }, icon: Megaphone },
      { id: "platform-usage", label: { key: "nav.items.platform_usage" }, icon: Activity, adminOnly: true },
      { id: "mcp", label: { key: "nav.items.mcp" }, icon: Server, unbuilt: true },
      { id: "config", label: { key: "nav.items.config" }, icon: Settings2, unbuilt: true },
      { id: "scorecard-mgmt", label: { key: "nav.items.scorecard" }, icon: BarChart3, unbuilt: true },
    ],
  },
];

export const MANAGE_ITEMS: readonly PaneItem[] = MANAGE_GROUPS.flatMap(
  (group) => group.items,
);

export function zoneItems(zoneId: string): readonly PaneItem[] {
  if (zoneId === "people") return PEOPLE_ITEMS;
  if (zoneId === "manage") return MANAGE_ITEMS;
  return (ZONE_SECTIONS[zoneId] ?? []).flatMap((g) => g.items);
}

export function defaultZoneItem(zoneId: string): string | null {
  return resolveZoneItem(zoneId, null, EMPTY_NAV_POLICY);
}

export function resolveZoneItem(
  zoneId: string,
  item: string | null,
  policy: InstanceNavPolicy = navPolicy(),
): string | null {
  const shown = (i: PaneItem) => !i.unbuilt && !itemHidden(zoneId, i.id, policy);
  const live = (i: PaneItem) => !itemPlanned(zoneId, i.id, policy);
  const items = zoneItems(zoneId);
  if (item && items.some((i) => i.id === item && shown(i))) return item;
  return items.find((i) => live(i) && shown(i) && !i.adminOnly && !i.previewsGated)?.id ?? null;
}
