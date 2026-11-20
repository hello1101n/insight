import type { GridHeightClass, GridSizeClass } from '@gears-frontx/ui-kit';

/*
 * The dashboard and widget contract as TypeScript types. The bundle schemas in
 * ./gts are the normative definition; these types mirror them for the code of
 * the dashboard root and the widgets.
 */

// @cpt-dod:cpt-frontx-dashboard-dod-widget-contract-request:p1
/** A request the dashboard root sends to the product's API. */
export interface DashboardRequest {
  method: 'GET' | 'POST';
  /** An absolute same-origin path; the query string is part of it. */
  path: string;
  /** JSON body, only with POST. */
  body?: unknown;
  /** Query key (GET) or top-level body field (POST) to the name of the variable whose host value goes there. */
  variables?: Record<string, string>;
}

/**
 * How a widget formats the numbers it shows. percent 0.25 means 25%. `decimals` is the exact number of fraction
 * digits; `unit_label` is a unit word after a number; `currency` is an ISO 4217 code.
 */
export type ValueFormat = { decimals?: number } & (
  | { value_type: 'number'; unit_label?: string }
  | { value_type: 'percent' }
  | { value_type: 'duration'; unit: 'ms' | 's' | 'min' | 'h' | 'd' }
  | { value_type: 'currency'; currency: string }
);

// @cpt-dod:cpt-frontx-dashboard-dod-widget-contract-base:p1
/** A widget instance as embedded in a cell: the widget base fields. A concrete widget type closes `render`, through its own render type or inline. */
export interface WidgetInstance {
  /** Combined anonymous id: the widget type chain followed by a lowercase UUID. */
  id: string;
  title?: string;
  /** A short line under the title; without it the header shows the title alone. */
  description?: string;
  render: Record<string, unknown>;
  /** Data widgets only. */
  value_format?: ValueFormat;
  /** Data widgets only: the binding (ADR-0011). */
  data?: unknown;
}

// @cpt-dod:cpt-frontx-dashboard-dod-dashboard-model-type:p1
/** One cell of the layout: a size class and a height class of the ui-kit Grid, and the widget it renders. */
export interface DashboardCell {
  size: GridSizeClass;
  /** `low` when absent. */
  height?: GridHeightClass;
  /** `true` when absent; `false` draws the widget with no card, header or larger-view button. */
  frame?: boolean;
  widget: WidgetInstance;
  larger_view?: WidgetInstance;
}

export interface DashboardLayout {
  /** In reading and keyboard order. */
  cells: DashboardCell[];
  /** Lets spans move inside each size class's range to fill rows. `true` when absent. */
  flexible?: boolean;
}

export interface Dashboard {
  id: string;
  title: string;
  description?: string;
  requests?: Record<string, DashboardRequest>;
  layout: DashboardLayout;
}

/** The payload of the `render_widget` action: everything a widget gets. */
export interface RenderWidgetPayload<TRender = Record<string, unknown>, TData = unknown> {
  render: TRender;
  value_format?: ValueFormat;
  data?: TData;
}

export const DASHBOARD_TYPE_ID = 'gts.frontx.dashboard.dashboard.dashboard.v1~';
export const WIDGET_BASE_TYPE_ID = 'gts.frontx.dashboard.widget.widget.v1~';
export const REQUEST_TYPE_ID = 'gts.frontx.dashboard.widget.request.v1~';
export const DATA_WIDGET_TYPE_ID = 'gts.frontx.dashboard.widget.widget.v1~frontx.dashboard.widget.data_widget.v1~';
export const WIDGET_DATA_BASE_ID = 'gts.frontx.dashboard.widget_data.widget_data.v1~';
export const RENDER_WIDGET_ACTION_ID = 'gts.frontx.mfes.comm.action.v1~frontx.dashboard.mfe.render_widget.v1~';
export const WIDGET_EXT_TYPE_ID = 'gts.frontx.mfes.ext.extension.v1~frontx.dashboard.mfe.widget_ext.v1~';
export const WIDGETS_DOMAIN_ID = 'gts.frontx.mfes.ext.domain.v1~frontx.dashboard.mfe.widgets.v1';
export const ENTRY_MF_TYPE_ID = 'gts.frontx.mfes.mfe.entry.v1~frontx.mfes.mfe.entry_mf.v1~';
/** The FrontX theme and language shared properties the `widgets` domain shares; every widget entry requires both. */
export const THEME_PROPERTY_ID = 'gts.frontx.mfes.comm.shared_property.v1~frontx.mfes.comm.theme.v1~';
export const LANGUAGE_PROPERTY_ID = 'gts.frontx.mfes.comm.shared_property.v1~frontx.mfes.comm.language.v1~';

/** Host theme ids whose palette is dark; any other id maps to the kit's light scope. */
export const DARK_THEMES = new Set(['dark', 'dracula', 'dracula-large']);

/** The kit theme scope a host theme id draws in: the dashboard root and every widget share it. */
export const kitScopeOf = (theme: string | undefined): 'light' | 'dark' => (theme && DARK_THEMES.has(theme) ? 'dark' : 'light');

/**
 * The host language as every Intl constructor and the `lang` attribute take it: the dashboard frame and every widget
 * share it. The language property is a free string, so the host can deliver one that is not a BCP-47 tag ("pt_BR",
 * ""); Intl rejects it with a RangeError, so it falls back to `en`.
 */
export function intlLocaleOf(locale: string | undefined): string {
  try {
    return Intl.getCanonicalLocales(locale ?? 'en')[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/** The served GTS file: the types and the instances (manifests, entries, dashboards) the root registers at runtime. */
export interface ServedFile {
  types: Record<string, unknown>[];
  instances: Record<string, unknown>[];
}

/** What a host answers to the dashboard request: one served file, or the file in parts, the base file first, then one part per widget bundle. */
export type ServedAnswer = ServedFile | ServedFile[];
