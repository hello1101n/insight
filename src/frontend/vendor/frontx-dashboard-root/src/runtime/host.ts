import type { DashboardRequest, ServedAnswer } from '../contract';
import { loadWidgetParts, withWidgetParts } from './served';

/*
 * What the dashboard root asks of its host (DESIGN §3.3 Host interface). The
 * root never reaches the network on its own: it sends two kinds of request to
 * the host, and the host answers them.
 */

/** No request, the served file's included, is waited on for longer than this. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** The largest response body `fetchHost` accepts: 1 MiB, counted after decoding. */
export const RESPONSE_SIZE_CAP = 1_048_576;

export interface DashboardHost {
  /**
   * The dashboard request: answers with the served GTS file (`{types, instances}`), or with the file in parts, a
   * list whose first item is the base file (the catalog types and the dashboards) and whose other items are the
   * widget bundles' parts. The root registers each part on its own, so a part it rejects fails only its cells. The
   * answer comes from the network: the root checks its shape, and an answer of another shape fails every dashboard.
   */
  loadFile(signal: AbortSignal): Promise<ServedAnswer>;
  /**
   * The data request of a binding: answers with the parsed JSON body for
   * `request`. A rejection fails every cell that depends on the request.
   */
  request(request: DashboardRequest, signal: AbortSignal): Promise<unknown>;
}

/** A failed request: the cell (or every cell depending on a shared request) shows its cannot-be-shown state. */
export class RequestFailure extends Error {}

/** The request type's `path` pattern: a single leading `/` not followed by `/` or `\`, no control characters. */
const PATH = /^\/([^/\\\x00-\x1F\x7F][^\x00-\x1F\x7F]*)?$/;

/**
 * A path as a failure line quotes it: without its query and fragment, where the root put the host's variable values.
 * A failure names a variable, never its value.
 */
export const quotedPath = (path: string) => path.replace(/[?#][\s\S]*$/, '');

/** A same-origin request target: the path pattern holds and the path resolves to `origin` (DESIGN §2.2). */
export function isSameOriginPath(path: string, origin: string): boolean {
  if (!PATH.test(path)) return false;
  try {
    return new URL(path, origin).origin === origin;
  } catch {
    return false;
  }
}

/** Runs `run` with an abort signal that fires after `ms`; a late answer is a timeout failure. */
export async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RequestFailure(`no answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a body up to the 1 MiB cap and stops reading as soon as it passes it. */
async function readCapped(response: Response, path: string): Promise<Uint8Array> {
  const over = () => new RequestFailure(`${path} answered more than ${RESPONSE_SIZE_CAP} bytes, over the 1 MiB cap`);
  if (Number(response.headers.get('content-length') ?? 0) > RESPONSE_SIZE_CAP && !response.headers.get('content-encoding')) throw over();
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > RESPONSE_SIZE_CAP) {
      await reader.cancel();
      throw over();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

/**
 * The default host: the served file from `fileUrl` and every binding request
 * from the page's own origin, with the same-origin check, the 2xx and JSON
 * rules and the 1 MiB cap of DESIGN §3.5. With `widgetList`, the address of
 * the served widget list, the answer is the served file at `fileUrl` (or the
 * files of a list it holds) followed by the part of every widget bundle on
 * that list (DESIGN §3.3 Widget bundles). A product
 * whose data does not come from its own origin passes its own `DashboardHost`
 * instead.
 */
export function fetchHost({ fileUrl, widgetList, origin = globalThis.location?.origin ?? '' }: { fileUrl: string; widgetList?: string; origin?: string }): DashboardHost {
  // `binding` requests follow every rule of DESIGN §3.5; the served file is trusted, product-served input and may come from any URL.
  const read = async (path: string, init: RequestInit, binding = true) => {
    // Every line below quotes the path without its query: a binding request's query carries the host's values.
    const quoted = quotedPath(path);
    if (binding && !isSameOriginPath(path, origin)) throw new RequestFailure(`${quoted} is not a same-origin path`);
    let response: Response;
    try {
      // A binding request does not follow a redirect: following it would send the query, with the host's values, to wherever the redirect points.
      response = await fetch(new URL(path, origin), binding ? { ...init, redirect: 'manual' } : init);
    } catch (error) {
      throw new RequestFailure(`network error: ${String(error)}`);
    }
    if (binding && (response.type === 'opaqueredirect' || (response.status >= 300 && response.status <= 399))) throw new RequestFailure(`${quoted} redirected`);
    // A second guard: with no redirect followed, only a service worker can answer from another address.
    if (binding && new URL(response.url || new URL(path, origin).href).origin !== origin) throw new RequestFailure(`${quoted} answered from another origin`);
    if (response.status < 200 || response.status > 299) throw new RequestFailure(`${quoted} answered ${response.status}`);
    const bytes = binding ? await readCapped(response, quoted) : new Uint8Array(await response.arrayBuffer());
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new RequestFailure(`${quoted} did not answer valid JSON`);
    }
  };
  return {
    loadFile: async (signal) => {
      const file = await read(fileUrl, { method: 'GET', signal }, false);
      if (!widgetList) return file as ServedAnswer;
      return withWidgetParts(file, () => loadWidgetParts(widgetList, signal, new URL(fileUrl, origin).href));
    },
    request: (request, signal) =>
      read(request.path, {
        method: request.method,
        signal,
        ...(request.method === 'POST' ? { body: JSON.stringify(request.body ?? null), headers: { 'content-type': 'application/json' } } : {}),
      }),
  };
}
