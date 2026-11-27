import type { MfeEntryLifecycle } from '@gears-frontx/mfes';
import { ENTRY_MF_TYPE_ID, type ServedFile } from '@gears-frontx/frontx-dashboard-root/contract';

import { createWidgetLifecycle, type WidgetRenderer } from './lifecycle';

/** The entry id of a catalog widget type, as the served file's entries and the types' `entry` traits name it. */
export const entryIdOf = (widgetType: string) => `${ENTRY_MF_TYPE_ID}frontx.dashboard.mfe.${widgetType}.v1`;

interface BundleSource {
  manifest: { id: string; remoteEntry: string };
  entries: Array<Record<string, unknown> & { id: string }>;
  /** The widget, render and data types the bundle declares, as its built part carries them. */
  schemas?: ServedFile['types'];
}

const renderers = import.meta.glob<WidgetRenderer>('../bundles/*/lifecycle.tsx', { eager: true, import: 'render' });
const sources = import.meta.glob<BundleSource>('../bundles/*/mfe.json', { eager: true, import: 'default' });
const bundles = Object.entries(sources).map(([file, source]) => ({ source, render: renderers[file.replace(/mfe\.json$/, 'lifecycle.tsx')] }));

/*
 * Tests only (the `./testing` export of the package). The catalog widgets reach a dashboard as
 * their own bundles (bundles/<widget_type>, built by build-bundles.mjs); these
 * two exports let the root run them from the product's bundle instead, where
 * no bundle server is at hand (jsdom tests). The widgets' CSS then stays in
 * the page, outside their shadow roots, so a browser shows them unstyled.
 */

/** Each catalog entry's lifecycle factory, by entry id: pass it to the dashboard root as `entries`. */
export const WIDGET_ENTRIES: Readonly<Record<string, () => MfeEntryLifecycle>> = Object.fromEntries(
  bundles.flatMap(({ source, render }) => source.entries.map((entry) => [entry.id, () => createWidgetLifecycle(render)])),
);

/** The types of each catalog bundle's part, by the bundle's name: the `schemas` its mfe.json declares, as the build writes them into the part. */
export const BUNDLE_TYPES: Readonly<Record<string, ServedFile['types']>> = Object.fromEntries(
  Object.entries(sources).map(([file, source]) => [file.match(/bundles\/([^/]+)\/mfe\.json$/)?.[1] ?? file, source.schemas ?? []]),
);

/**
 * The served-file parts of the catalog bundles without a build: each bundle's
 * manifest and entry, and the types its mfe.json declares in schemas, in
 * bundle order, as the build writes them into the bundle's part. With
 * `WIDGET_ENTRIES` the root never loads a chunk, so the manifests only have
 * to register.
 */
export const IN_BUNDLE_PARTS: ServedFile = {
  types: bundles.flatMap(({ source }) => source.schemas ?? []),
  instances: bundles.flatMap(({ source }) => [
    {
      id: source.manifest.id,
      name: source.manifest.id,
      metaData: {
        name: source.manifest.id,
        type: 'app',
        buildInfo: { buildVersion: '0.0.0', buildName: source.manifest.id },
        remoteEntry: { name: 'remoteEntry.js', path: '', type: 'module' },
        globalName: source.manifest.id,
        publicPath: new URL('./', new URL(source.manifest.remoteEntry, 'http://localhost/')).pathname,
      },
      shared: [],
    },
    ...source.entries.map((entry) => ({ ...entry, exposeAssets: { js: { sync: [], async: [] }, css: { sync: [], async: [] } } })),
  ]),
};
