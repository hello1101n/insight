import path from 'node:path';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { federation } from '@module-federation/vite';
// The FrontX manifest pipeline, from the shell template of this repository: the published shell package does not carry
// the version the FrontX MF handler of @gears-frontx/mfes 0.6.0 reads.
import { frontxMfGts } from '../../../../template-shell/src/build/mf-gts';

/*
 * One widget bundle: a Module Federation remote built the way template-mfe
 * builds its MFEs, for the FrontX MF handler (shared: {} for MF itself, the
 * shared dependencies kept as bare imports and published as standalone ESM by
 * the FrontX manifest pipeline). Run through build-bundles.mjs, which sets
 * WIDGET_TYPE and the directories.
 */

const type = process.env.WIDGET_TYPE;
if (!type) throw new Error('WIDGET_TYPE is not set: build the widget bundles with build-bundles.mjs');
const bundlesDir = process.env.WIDGET_BUNDLES_DIR ?? path.join(import.meta.dirname, 'bundles');
const outDir = process.env.WIDGET_BUNDLES_OUT ?? path.join(import.meta.dirname, 'dist');
const base = (process.env.WIDGET_BUNDLE_BASE ?? '/widgets/').replace(/\/?$/, '/');
const root = path.join(bundlesDir, type);

// Vite builds from an HTML page; a bundle has nothing to show on its own, so every bundle gets the same placeholder
// page from here instead of an index.html file of its own.
// Vite compares module ids with forward slashes, on Windows too.
const indexHtml = normalizePath(path.join(root, 'index.html'));
const PLACEHOLDER_PAGE = '<!DOCTYPE html><html><body>Widget bundle, not meant to be opened directly.</body></html>\n';
function placeholderPage(): Plugin {
  return {
    name: 'frontx-widget-placeholder-page',
    resolveId: (id) => (id === indexHtml ? indexHtml : null),
    load: (id) => (id === indexHtml ? PLACEHOLDER_PAGE : null),
  };
}

// Shared with every other bundle: the browser fetches one copy of each for all bundles whose builds agree on its
// content hash. recharts is shared only by the bundles that draw with it, so a bundle without charts never fetches
// it; a bundle that imports recharts without being listed here still works and carries its own copy.
const CHART_BUNDLES = new Set(['metric_card', 'cartesian_chart', 'pie_chart', 'radar_chart', 'waterfall_chart', ...(process.env.WIDGET_CHART_BUNDLES ?? '').split(',')]);
const REACT = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'];
const shared = CHART_BUNDLES.has(type) ? [...REACT, 'recharts'] : REACT;

export default defineConfig({
  root,
  plugins: [
    placeholderPage(),
    react(),
    federation({
      name: `widget_${type}`,
      filename: 'remoteEntry.js',
      exposes: { [`./${type}`]: './lifecycle.tsx' },
      shared: {},
      manifest: true,
      dts: false,
      publicPath: `${base}${type}/`,
    }),
    frontxMfGts(),
  ],
  build: {
    outDir: path.join(outDir, type),
    emptyOutDir: true,
    target: 'esnext',
    modulePreload: false,
    minify: true,
    cssCodeSplit: true,
    rollupOptions: { input: indexHtml, external: shared },
  },
});
