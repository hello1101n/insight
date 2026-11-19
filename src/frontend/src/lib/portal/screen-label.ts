import i18n from "@/i18n";
import { resolveText, type DisplayText } from "@/i18n/localized-text";
import { GROUPS } from "@/lib/insight/groups";
import { MODE_LABELS } from "@/lib/portal/identity-modes";
import {
  DIRECTIONS,
  MANAGE_ITEMS,
  PEOPLE_ITEMS,
  lensBySlug,
  zoneById,
  zoneItems,
} from "@/lib/portal/nav-model";
import {
  aiItem,
  homeItem,
  manageItem,
  reportItem,
  sectionOf,
  teamItem,
} from "@/lib/portal/portal-routes";

const SEPARATOR = " › ";

const DASHBOARD_PAGES: Record<string, DisplayText> = {
  dashboards: { key: "nav.rail.dashboards" },
  metrics: { key: "nav.items.metrics" },
  widgets: { key: "nav.items.widgets" },
  datasets: { key: "nav.items.datasets" },
  alerts: { key: "nav.items.alerts" },
  new: { key: "nav.items.new" },
  edit: { key: "nav.items.edit" },
};

const MASKED_ITEMS: Record<string, DisplayText> = {
  dashboards: { key: "nav.items.dashboard" },
  metrics: { key: "nav.items.metric" },
  widgets: { key: "nav.items.widget" },
  datasets: { key: "nav.items.dataset" },
  alerts: { key: "nav.items.alert" },
};

const PERSON_VIEWS: Record<string, DisplayText> = {
  personal: { key: "nav.personal" },
};

function itemLabel(zone: string, item: string): string {
  const items =
    zone === "manage" ? MANAGE_ITEMS : zone === "people" ? PEOPLE_ITEMS : zoneItems(zone);
  const label = items.find((candidate) => candidate.id === item)?.label;
  return label === undefined ? item : resolveText(i18n.t, label);
}

function sectionLabel(section: string): string {
  const title = GROUPS.find((group) => group.id === section)?.title;
  return title === undefined ? section : resolveText(i18n.t, title);
}

function customLabel(detail: string[]): string {
  return detail
    .filter(Boolean)
    .map((segment, i, segments) => {
      if (segment === ":id") {
        const masked = MASKED_ITEMS[segments[i - 1]];
        return masked ? resolveText(i18n.t, masked) : resolveText(i18n.t, { key: "nav.items.dashboard" });
      }
      const page = DASHBOARD_PAGES[segment];
      return page ? resolveText(i18n.t, page) : segment;
    })
    .join(SEPARATOR);
}

function detailLabel(zone: string, detail: string[]): string {
  const [third, fourth] = detail;
  if (zone === "directions") {
    const direction = DIRECTIONS.find((candidate) => candidate.id === third);
    if (!direction) return third;
    const name = resolveText(i18n.t, direction.name);
    if (!fourth) return name;
    const lens = lensBySlug(direction, fourth) ?? fourth;
    return `${name}${SEPARATOR}${lens}`;
  }
  if (zone === "custom") return customLabel(detail);
  const item = itemLabel(zone, third);
  if (zone === "manage" && third === "identities" && fourth) {
    return `${item}${SEPARATOR}${MODE_LABELS[fourth] ?? fourth}`;
  }
  return item;
}

export function screenLabel(path: string): string {
  const [, first, ...rest] = path.split("/");
  const [second, third, fourth] = rest;
  const zone = (id: string) => resolveText(i18n.t, zoneById(id)!.label);
  const under = (label: string, detail: string | undefined) =>
    detail ? `${label}${SEPARATOR}${detail}` : label;

  switch (first) {
    case "":
    case undefined:
      return resolveText(i18n.t, { key: "nav.home" });
    case "home":
      return under(zone("overview"), second && itemLabel("overview", homeItem(second) ?? second));
    case "explore": {
      if (second === "ai") return under(zone("aicost"), third && itemLabel("aicost", aiItem(third) ?? third));
      const direction = DIRECTIONS.find((candidate) => candidate.id === second);
      if (!direction) return zone("directions");
      return under(resolveText(i18n.t, direction.name), third && (lensBySlug(direction, third) ?? third));
    }
    case "people":
      if (third === "team") {
        return under(zone("people"), fourth && itemLabel("people", teamItem(fourth) ?? fourth));
      }
      return under(resolveText(i18n.t, { key: "nav.zones.person" }), third && sectionLabel(sectionOf(third)));
    case "reports":
      return under(zone("reports"), second && itemLabel("reports", reportItem(second) ?? second));
    case "manage": {
      const item = second && itemLabel("manage", manageItem(second) ?? second);
      if (second === "identities") return under(under(zone("manage"), item), third && (MODE_LABELS[third] ?? third));
      if (second === "ingestion") return under(under(zone("manage"), item), third);
      return under(zone("manage"), item);
    }
    case "dashboards":
      return under(zone("custom"), customLabel(rest) || undefined);
    case "portal":
    case "ic":
      // INVARIANT: usage rows recorded before pages had paths of their own still name screens this way.
      return legacyScreenLabel(path);
    default:
      return path;
  }
}

function legacyScreenLabel(path: string): string {
  const [, first, second, ...detail] = path.split("/");
  const [third, fourth] = detail;

  if (!first) return resolveText(i18n.t, { key: "nav.home" });

  if (first === "portal") {
    if (!second) return resolveText(i18n.t, { key: "nav.portal" });
    const zone = zoneById(second);
    if (!zone) {
      const group = GROUPS.find((candidate) => candidate.id === second);
      return group ? resolveText(i18n.t, group.title) : path;
    }
    const zoneLabel = resolveText(i18n.t, zone.label);
    if (!third) return zoneLabel;
    return `${zoneLabel}${SEPARATOR}${detailLabel(second, detail)}`;
  }

  if (first === "ic" && second) {
    if (third === "team") {
      const people = resolveText(i18n.t, zoneById("people")!.label);
      if (!fourth) return people;
      const item = PEOPLE_ITEMS.find((candidate) => candidate.id === fourth);
      const detailText = item ? resolveText(i18n.t, item.label) : sectionLabel(fourth);
      return `${people}${SEPARATOR}${detailText}`;
    }
    const view = PERSON_VIEWS[third ?? ""];
    if (!view) return path;
    const person = `${resolveText(i18n.t, { key: "nav.zones.person" })}${SEPARATOR}${resolveText(i18n.t, view)}`;
    return fourth ? `${person}${SEPARATOR}${sectionLabel(fourth)}` : person;
  }

  return path;
}
