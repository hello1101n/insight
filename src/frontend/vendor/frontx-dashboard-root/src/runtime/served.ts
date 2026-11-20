import type { ServedAnswer, ServedFile } from '../contract';
import { RequestFailure, withTimeout } from './host';
import { escapeControls } from './register';

/** How long one part may take: a part that does not answer in time is left out, so the healthy parts still arrive within the served file's own 30 s. */
export const PART_TIMEOUT_MS = 10_000;

/*
 * The served file in parts (DESIGN §3.3 Widget bundles): the catalog types,
 * one part per widget bundle (its manifest and entry, and the types a new
 * widget type brings), and the dashboards. A product serves the file in
 * parts, which the root registers one by one so a rejected part fails only its
 * own cells, or one joined file (`composeServedFile`), which registers as a
 * whole.
 */

/** Joins served-file parts in order: every part's types, then every part's instances. */
export function composeServedFile(...parts: ServedFile[]): ServedFile {
  return { types: parts.flatMap((part) => part.types), instances: parts.flatMap((part) => part.instances) };
}

export const isPart = (value: unknown): value is ServedFile =>
  value !== null && typeof value === 'object' && Array.isArray((value as ServedFile).types) && Array.isArray((value as ServedFile).instances);

/**
 * Runs `run` with a signal that aborts when either input does; by hand in browsers before AbortSignal.any (Safari
 * 17.3 and older), with the listeners removed once `run` settles so a long-lived caller signal keeps none.
 */
async function withEither<T>(first: AbortSignal, second: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (typeof AbortSignal.any === 'function') return run(AbortSignal.any([first, second]));
  const either = new AbortController();
  const sources = [first, second];
  const onAbort = (event: Event) => either.abort((event.target as AbortSignal).reason);
  const already = sources.find((source) => source.aborted);
  if (already) either.abort(already.reason);
  else for (const source of sources) source.addEventListener('abort', onAbort);
  try {
    return await run(either.signal);
  } finally {
    for (const source of sources) source.removeEventListener('abort', onAbort);
  }
}

async function readJson(url: URL, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    throw new RequestFailure(`network error for ${url.href}: ${String(error)}`);
  }
  if (!response.ok) throw new RequestFailure(`${url.href} answered ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new RequestFailure(`${url.href} did not answer valid JSON`);
  }
}

/**
 * A host's `loadFile` answer with the widget list's parts after it: after the file, or after the files of an answer
 * that is already a list. An answer that is neither `{types, instances}` nor a non-empty list goes to the root
 * unchanged, whose own check names the problem, and the list is not read.
 */
export async function withWidgetParts(answer: unknown, loadParts: () => Promise<ServedFile[]>): Promise<ServedAnswer> {
  if (Array.isArray(answer) && answer.length > 0) return [...(answer as ServedFile[]), ...(await loadParts())];
  if (isPart(answer)) return [answer, ...(await loadParts())];
  return answer as ServedAnswer;
}

/**
 * Reads the served widget list at `listUrl`, a JSON array of the addresses of
 * the widget bundles' parts (`widget.gts.json`), and every part it names,
 * relative addresses against the list's own. A part that cannot be read is
 * left out with one console line: its widget types then have no entry, so
 * only their cells fail. A part that is read but that the registry rejects
 * is left out at registration in the same way (`registerServedFile`). A list
 * that cannot be read rejects.
 */
export async function loadWidgetParts(listUrl: string, signal: AbortSignal, base: string = globalThis.location?.href ?? '', partTimeoutMs: number = PART_TIMEOUT_MS): Promise<ServedFile[]> {
  const listAt = new URL(listUrl, base);
  const list = await readJson(listAt, signal);
  if (!Array.isArray(list) || !list.every((item) => typeof item === 'string')) throw new RequestFailure(`${listAt.href} is not a list of addresses`);
  const parts = await Promise.all(
    list.map(async (address) => {
      let at: URL | undefined;
      try {
        // Built inside the boundary: a malformed address leaves out only its own part.
        at = new URL(address, listAt);
        const target = at;
        // The part's own deadline; the caller's cancellation still reaches its request.
        const part = await withTimeout((own) => withEither(signal, own, (either) => readJson(target, either)), partTimeoutMs);
        if (!isPart(part)) throw new RequestFailure(`${at.href} has no types and instances lists`);
        return part;
      } catch (error) {
        if (signal.aborted) throw error;
        // The address comes from the served list, so a line break in it would fake another console line.
        console.error(`[dashboard] ${escapeControls(`the widget part ${at?.href ?? address} is left out: ${error instanceof Error ? error.message : String(error)}`)}`);
        return undefined;
      }
    }),
  );
  return parts.filter((part): part is ServedFile => part !== undefined);
}
