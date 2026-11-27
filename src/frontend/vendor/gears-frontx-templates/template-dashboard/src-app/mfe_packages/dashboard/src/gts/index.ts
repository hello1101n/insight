import dashboard from './dashboard.v1.schema.json';
import dataWidget from './data_widget.v1.schema.json';
import render from './render.v1.schema.json';
import renderWidget from './render_widget.v1.schema.json';
import request from './request.v1.schema.json';
import tones from './tones.v1.schema.json';
import valueFormat from './value_format.v1.schema.json';
import widgetData from './widget_data.v1.schema.json';
import widgetExt from './widget_ext.v1.schema.json';
import widget from './widget.v1.schema.json';
import widgetsDomain from './widgets_domain.v1.json';
import { ENTRY_MF_TYPE_ID, LANGUAGE_PROPERTY_ID, THEME_PROPERTY_ID } from '../contract';

/**
 * The bundle schemas the dashboard root registers at start, before it loads
 * the served GTS file: the widget base, `data_widget`, the render base, the
 * value_format type, the tones type, the request type, the widget-data base, the
 * `render_widget` action, the `widgets` extension type and the dashboard type.
 * The order does not matter for `$ref`s: registering a schema resolves none of
 * them (the plugin's store runs with gts-ts `validateRefs` off), and gts-ts
 * resolves all of a schema's `$ref`s, transitively, only when it compiles the
 * schema to validate something against it. So `data_widget` may name the
 * value_format and request types, which come after it, and a catalog render
 * type may name the tones type. What matters is that
 * every bundle type is registered before any instance.
 */
export const BUNDLE_SCHEMAS: ReadonlyArray<Record<string, unknown>> = [widget, dataWidget, render, valueFormat, tones, request, widgetData, renderWidget, widgetExt, dashboard];

/** The `widgets` domain instance (widget contract FEATURE). */
export const WIDGETS_DOMAIN = widgetsDomain;

/**
 * The FrontX theme and language shared-property types. FrontX refers to them
 * by id but does not define them; a FrontX shell registers its own. The root
 * registers these only where the type store has none, so a host without a
 * shell can register the `widgets` domain and the widget entries, which name
 * both properties.
 */
export const SHARED_PROPERTY_SCHEMAS: ReadonlyArray<Record<string, unknown>> = [THEME_PROPERTY_ID, LANGUAGE_PROPERTY_ID].map((id) => ({
  $id: `gts://${id}`,
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  allOf: [{ $ref: 'gts://gts.frontx.mfes.comm.shared_property.v1~' }],
  properties: { value: { type: 'string', minLength: 1 } },
}));

const STAND_IN_MANIFEST_ID = 'gts.frontx.mfes.mfe.mf_manifest.v1~frontx.dashboard.stand_in.manifest.v1';
const STAND_IN_ENTRY_ID = `${ENTRY_MF_TYPE_ID}frontx.dashboard.mfe.stand_in.v1`;

/** The open stand-in widget type: the base fields only, so a stand-in instance keeps every base check of the widget it stands in for. */
export const STAND_IN_TYPE_ID = 'gts.frontx.dashboard.widget.widget.v1~frontx.dashboard.widget.stand_in.v1~';

/**
 * The stand-in the root registers in place of an embedded widget that failed
 * its own registration, so the dashboard still validates and that failure
 * stays in its own cell (DESIGN §3.6, ADR-0003). Its entry is never mounted.
 */
export const STAND_IN: { schema: Record<string, unknown>; instances: Record<string, unknown>[] } = {
  schema: {
    $id: `gts://${STAND_IN_TYPE_ID}`,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Stand-in widget',
    description: 'Stands in, inside the dashboard the root validates, for an embedded widget that failed its own registration. Never mounted.',
    'x-gts-traits': { entry: STAND_IN_ENTRY_ID },
    allOf: [{ $ref: 'gts://gts.frontx.dashboard.widget.widget.v1~' }],
  },
  instances: [
    {
      id: STAND_IN_MANIFEST_ID,
      name: 'frontx_dashboard_stand_in',
      metaData: { name: 'frontx_dashboard_stand_in', type: 'app', buildInfo: { buildVersion: '0', buildName: 'stand-in' }, remoteEntry: { name: 'none', path: '', type: 'module' }, publicPath: '/' },
      shared: [],
    },
    {
      id: STAND_IN_ENTRY_ID,
      requiredProperties: [],
      actions: [],
      domainActions: [],
      manifest: STAND_IN_MANIFEST_ID,
      exposedModule: './stand_in',
      exposeAssets: { js: { sync: [], async: [] }, css: { sync: [], async: [] } },
    },
  ],
};
