#!/usr/bin/env node
/*
 * Builds every widget bundle under bundles/ (or the ones named on the command
 * line) as its own Module Federation remote, into dist/<widget_type>/. The
 * bundles build in parallel: the parent spawns this same script as child
 * processes, one bundle per child (WIDGET_BUILD_CHILD=<type> marks a child),
 * as many at a time as WIDGET_BUILD_JOBS or --jobs N sets (N >= 1, --jobs
 * wins), by default
 * min(DEFAULT_JOBS, os.availableParallelism(), the bundles to build): 4 at a
 * time, fewer on a machine with fewer cores or fewer bundles to build. A child
 * runs one bundle and nothing else: the vite build, then the bundle's
 * served-file part.
 * The parent buffers each child's output and writes it out whole when the
 * child ends, so the lines of two bundles never share a line, and starts no
 * new bundle once one child failed: the build then exits 1 and its last line
 * names every failed bundle. dist/widgets.json is written once, at the end,
 * only when every bundle built: the served widget list, the address of every
 * part it lists. A full build (no bundle named on the command line) owns the
 * catalog of its out dir: it removes the previous dist/widgets.json before the
 * first bundle builds, so a failed build leaves no stale list behind, and
 * lists only the bundles of this run that built, so a part directory an
 * earlier build left in the out dir stays on disk but is no longer listed, and
 * nothing loads it; a run that names bundles starts from the existing list,
 * the parts of the last full build plus the bundles built by name since,
 * keeps its entries and adds the bundles it built, so a part the list no
 * longer names stays off it; only when no list
 * is there to start from, after a failed full build say, does it rewrite the
 * list from every part directory of the out dir, as before. A list that is
 * not a list of addresses, or one that names an address under another
 * WIDGET_BUNDLE_BASE, stops the run before the first bundle builds, an entry
 * whose part is not in the out dir is dropped with a warning, and the
 * fallback says it is listing every part directory; any run leaves the list
 * as it is when it fails. Each bundle gets its
 * served-file part next to it,
 * dist/<widget_type>/widget.gts.json: the manifest and the entry the FrontX
 * manifest pipeline completed from the build, the types the bundle's mfe.json
 * declares in schemas, and the types and instances of the bundle's own
 * served.gts.json when it has one.
 *
 * WIDGET_BUNDLE_BASE is the address the bundles are served under, '/widgets/'
 * by default: a bundle's chunks load from <base><widget_type>/. It,
 * WIDGET_BUNDLES_DIR, WIDGET_BUNDLES_OUT and the child mark
 * WIDGET_BUILD_CHILD pass to the children through the environment.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = import.meta.dirname;
const script = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
// A base written without its trailing slash still names a directory.
const base = (process.env.WIDGET_BUNDLE_BASE ?? '/widgets/').replace(/\/?$/, '/');
process.env.WIDGET_BUNDLE_BASE = base;
const bundlesDir = process.env.WIDGET_BUNDLES_DIR ? path.resolve(process.env.WIDGET_BUNDLES_DIR) : path.join(here, 'bundles');
const outDir = process.env.WIDGET_BUNDLES_OUT ? path.resolve(process.env.WIDGET_BUNDLES_OUT) : path.join(here, 'dist');
// The children read both back from the environment.
process.env.WIDGET_BUNDLES_DIR = bundlesDir;
process.env.WIDGET_BUNDLES_OUT = outDir;

// writeSync so the message survives process.exit when stderr is a pipe.
const failWith = (message) => {
  writeSync(2, `${message}\n`);
  process.exit(1);
};
const parseJobs = (value, origin) => {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) failWith(`${origin} must be a whole number of 1 or more, got "${value}"`);
  return count;
};

// Measured on 15 bundles: 4 at a time is about 2.3 times faster than one at a time, at about a third of the memory of all at once.
const DEFAULT_JOBS = 4;

// A child builds the bundle named in the environment: the parent sets
// WIDGET_BUILD_CHILD when it spawns a child, so the command line carries no
// child option.
const only = process.env.WIDGET_BUILD_CHILD || undefined;

if (only !== undefined) {
  // A child: the per-bundle body, nothing else.
  const { build } = await import('vite');
  process.env.WIDGET_TYPE = only;
  await build({ configFile: path.join(here, 'vite.bundle.config.ts'), logLevel: 'warn' });
  const { manifest, entries, schemas } = JSON.parse(readFileSync(path.join(outDir, only, 'mfe-manifest.json'), 'utf-8'));
  // The served file names the manifest by id; its own `remoteEntry` field is the authoring input only.
  const { remoteEntry: _authored, ...served } = manifest;
  // The part's types are the ones the bundle's mfe.json declares in schemas (the widget, render and data types of
  // its widget type, carried through the build), then the types of its own served.gts.json when it has one.
  const extraPath = path.join(bundlesDir, only, 'served.gts.json');
  const extra = existsSync(extraPath) ? JSON.parse(readFileSync(extraPath, 'utf-8')) : { types: [], instances: [] };
  const part = { types: [...(schemas ?? []), ...(extra.types ?? [])], instances: [served, ...entries, ...(extra.instances ?? [])] };
  writeFileSync(path.join(outDir, only, 'widget.gts.json'), `${JSON.stringify(part, null, 2)}\n`);
  console.log(`built ${only}`);
} else {
  // The parent: one child per bundle, at most `count` children at a time.
  const named = [];
  let cap;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--jobs') {
      if (index === argv.length - 1) failWith('--jobs needs the number of bundles to build at a time');
      index += 1;
      cap = parseJobs(argv[index], '--jobs');
    } else if (arg.startsWith('--jobs=')) {
      cap = parseJobs(arg.slice('--jobs='.length), '--jobs');
    } else if (arg.startsWith('-')) {
      failWith(`unknown option ${arg}: the parent takes --jobs N and the names of bundles to build`);
    } else {
      named.push(arg);
    }
  }
  const fromEnv = process.env.WIDGET_BUILD_JOBS?.trim();
  if (cap === undefined && fromEnv) cap = parseJobs(fromEnv, 'WIDGET_BUILD_JOBS');
  // A type named twice still builds once: two children would write one dist/<type>.
  const types = [...new Set(named.length ? named : readdirSync(bundlesDir).filter((name) => existsSync(path.join(bundlesDir, name, 'mfe.json'))))];
  const count = cap ?? Math.min(DEFAULT_JOBS, os.availableParallelism(), types.length);
  // A full build owns the catalog of its out dir: it drops the previous
  // widgets.json before the first bundle builds, and the list it writes at the
  // end names only the bundles of this run, so a failed build leaves no stale
  // list for the dev host to serve over a mix of old and new bundles, and a
  // part directory an earlier build left in the out dir stays on disk but is
  // no longer listed, so nothing loads it (the runtime and the schema store
  // reach a part only through the list). A run that names bundles starts from
  // the existing widgets.json, the list the build itself writes: its
  // addresses map back to the part names of the catalog, the bundles of this
  // run join them, and a part directory the list no longer names stays off
  // it. Only when no widgets.json is there to start from, after a failed full
  // build say, does the run read the entries back from every
  // dist/*/widget.gts.json, and the list stays as it is when the run fails,
  // as before.
  const widgetsPath = path.join(outDir, 'widgets.json');
  const full = named.length === 0;
  if (full && existsSync(widgetsPath)) unlinkSync(widgetsPath);
  let next = 0;
  let running = 0;
  const failed = [];

  // The parent told to stop on its own (SIGTERM from a CI step or a container
  // stop, SIGINT sent to its pid only) takes every live child down with the
  // same signal, then exits 130 or 143: no child is left building into dist/.
  // A SIGKILL of the parent cannot be handled (no handler runs), so a parent
  // killed that way stays out of reach here. The handlers go in once, before
  // the first spawn, not per child.
  const children = new Set();
  const signalChildren = (signal) => {
    for (const child of children) child.kill(signal);
  };
  process.on('SIGINT', () => {
    signalChildren('SIGINT');
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    signalChildren('SIGTERM');
    process.exit(143);
  });

  // The entries a run that names bundles starts from, read and checked before the first child spawns, so a list
  // this run cannot use stops the run before anything is built for nothing. A list that does not read back as a
  // list of addresses stops the run with the way out; so does an address under another base, which the filter
  // would otherwise drop without a word. An entry whose part is not a directory of the out dir, or whose name is
  // empty or carries a path separator, is dropped with one warning naming it, so the list the run writes names
  // only parts that are there. With no list to start from, after a failed full build say, the run falls back to
  // every part directory of the out dir and says so. An out dir that is not there at all, on a fresh clone or a
  // new WIDGET_BUNDLES_OUT say, holds no previous parts and no dist/widgets.json either: the run starts from an
  // empty list without the listing line, since there is no part directory to list, and builds the bundles it was
  // given.
  const previousParts = () => {
    if (full) return [];
    if (!existsSync(outDir)) return [];
    if (!existsSync(widgetsPath)) {
      console.log('no dist/widgets.json: listing every part directory in dist/; run the full build to drop parts no bundle builds');
      return readdirSync(outDir).filter((name) => existsSync(path.join(outDir, name, 'widget.gts.json')));
    }
    let addresses;
    try {
      addresses = JSON.parse(readFileSync(widgetsPath, 'utf-8'));
    } catch {
      addresses = null;
    }
    if (!Array.isArray(addresses) || !addresses.every((address) => typeof address === 'string')) {
      failWith('dist/widgets.json is not a list of addresses, remove it or run the full build');
    }
    const stray = addresses.find((address) => !address.startsWith(base));
    if (stray !== undefined) failWith(`${stray} does not start with the base ${base} of this run: built with another WIDGET_BUNDLE_BASE? set it, or run the full build`);
    const kept = [];
    const dropped = [];
    for (const address of addresses) {
      const name = address.endsWith('/widget.gts.json') ? address.slice(base.length, -'/widget.gts.json'.length) : '';
      if (name && !name.includes('/') && !name.includes('..') && existsSync(path.join(outDir, name, 'widget.gts.json'))) kept.push(name);
      else dropped.push(address);
    }
    if (dropped.length) console.log(`dropping from dist/widgets.json, not parts of this dist: ${dropped.join(', ')}`);
    return kept;
  };
  const previous = previousParts();

  const finish = () => {
    if (failed.length) {
      console.log(`failed: ${failed.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    // Sorted, so the list is the same on every file system: readdirSync order is the directory's own. A full build
    // lists the bundles of this run, which all built here, and nothing else; a run that names bundles starts from
    // the entries read and checked before the first child spawned, and adds the bundles it built.
    const listed = [...new Set([...previous, ...types])].sort();
    writeFileSync(path.join(outDir, 'widgets.json'), `${JSON.stringify(listed.map((type) => `${base}${type}/widget.gts.json`), null, 2)}\n`);
    // A full build owns the catalog of its out dir: the part directories it did not build, and so did not list, come
    // out in one line, so a stale part an earlier build left behind is named rather than dropped without a word.
    if (full) {
      const unlisted = readdirSync(outDir).filter((name) => !listed.includes(name) && existsSync(path.join(outDir, name, 'widget.gts.json'))).sort();
      if (unlisted.length) console.log(`not listed: ${unlisted.join(', ')} (part directories in ${outDir} this build did not build)`);
    }
  };

  const startNext = () => {
    // No new bundle starts once one failed; the ones already running end.
    while (failed.length === 0 && next < types.length && running < count) {
      const type = types[next];
      next += 1;
      running += 1;
      let child;
      try {
        child = spawn(process.execPath, [script], { env: { ...process.env, WIDGET_BUILD_CHILD: type }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        // Some errno values make spawn() throw instead of emitting 'error'
        // (ENOMEM among them): report it, count the bundle failed, and do not
        // count it as running, so the build ends with the failed summary
        // instead of crashing.
        writeSync(2, `${type}: ${error.message}\n`);
        running -= 1;
        failed.push(type);
        continue;
      }
      children.add(child);
      let out = '';
      let err = '';
      let settled = false;
      // EMFILE and ENFILE leave the child without pipes to read.
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { out += chunk; });
      child.stderr?.on('data', (chunk) => { err += chunk; });
      // A child settles once, on the first of 'close' and 'error'. 'error'
      // covers the async spawn failures (EACCES, EAGAIN, EMFILE, ENFILE,
      // ENOENT): such a child may never emit 'close', so it is still counted,
      // its error recorded, and the build ends with the failed summary instead
      // of crashing on the unhandled event. Other spawn failures throw from
      // spawn() and are caught above.
      const settle = (failedRun) => {
        if (settled) return;
        settled = true;
        children.delete(child);
        running -= 1;
        // A child's output goes out whole, so two bundles never share a line.
        if (out) process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
        if (err) process.stderr.write(err.endsWith('\n') ? err : `${err}\n`);
        if (failedRun) failed.push(type);
        startNext();
        if (running === 0) finish();
      };
      child.on('error', (error) => {
        err += `${type}: ${error.message}\n`;
        settle(true);
      });
      child.on('close', (code, signal) => {
        // A child the kernel killed (an OOM kill, say) closes with no code and
        // the signal: say so next to its output, and count the bundle failed.
        if (signal) err += `${type}: killed by ${signal}\n`;
        settle(code !== 0);
      });
    }
  };

  startNext();
  if (running === 0) finish();
}
