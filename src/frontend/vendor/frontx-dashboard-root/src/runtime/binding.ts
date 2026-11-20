import type { DashboardRequest } from '../contract';
import { compileTransform } from './cel';
import { isSameOriginPath, quotedPath, withTimeout, type DashboardHost } from './host';

/*
 * The binding runner (DESIGN §3.2, runtime FEATURE "Run a binding"): it turns
 * a widget's binding into data. Own and shared bindings ask the host for the
 * request's answer; a static binding needs no request. The caller stamps and
 * registers the result.
 */

export type Binding =
  | { request: DashboardRequest; transform: string }
  | { source: string; params?: Record<string, unknown>; transform: string }
  | { params?: Record<string, unknown>; transform: string };

export type BindingForm = 'own' | 'shared' | 'static';

export const formOf = (binding: Binding): BindingForm => ('request' in binding ? 'own' : 'source' in binding ? 'shared' : 'static');

/**
 * The variable names a binding depends on: those its own request names, or those its shared request names. Anything
 * that is not a plain-object request with plain-object `variables` of string values gives none: the cell's own run
 * reports what is wrong.
 */
export function variablesOfBinding(binding: Binding, shared: SharedRequests): string[] {
  const form = formOf(binding);
  if (form === 'own') {
    const { request } = binding as { request: unknown };
    const variables = isPlainObject(request) ? request.variables : undefined;
    return isPlainObject(variables) && Object.values(variables).every((name) => typeof name === 'string') ? (Object.values(variables) as string[]) : [];
  }
  const { source } = binding as { source: unknown };
  return form === 'shared' && typeof source === 'string' ? shared.variablesOf(source) : [];
}

/** A failure of one cell, with the developer-log text naming the failing step or request. */
export class CellFailure extends Error {}

/**
 * A cell failure because the data request itself failed after it left the root: the host rejected it (a network
 * error, an HTTP status outside 2xx, an answer that is not JSON or is over the cap, a redirect answer) or
 * it timed out. Sending it again may help, so the cell offers a retry. A request the root refused to build or send
 * (a variable the host gives no value for, an unknown source, a method other than GET or POST, a path that is not same-origin) is a plain
 * `CellFailure`.
 */
export class RequestFailed extends CellFailure {}

/** The outcome of a binding: the data, or nothing when the cell left before it finished. */
export type BindingResult = { dropped: false; data: unknown } | { dropped: true };

/** The value of each variable, by name, as the host gives it through the `variables` input. */
export type VariableValues = Readonly<Record<string, string | number | boolean>>;

const NO_VALUES: VariableValues = {};

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A host value that threw while it was read. */
export const UNREADABLE = Symbol('unreadable');

/**
 * The host's value of `name`: `{ value }`, nothing when the host gives none, or `UNREADABLE` when a getter or a Proxy
 * of the host's object throws; the error is dropped, as it may carry the value.
 */
export function readValue(values: VariableValues, name: string): { value: unknown } | undefined | typeof UNREADABLE {
  try {
    return Object.hasOwn(values, name) ? { value: values[name] } : undefined;
  } catch {
    return UNREADABLE;
  }
}

/**
 * The request the host gets: each key of `variables` gets the host's value of the variable it names, appended to
 * the path's query for GET (as text, after any query already there, encoded by `URLSearchParams`) or set as a
 * top-level body field for POST (as given). The built request carries no `variables` field. A key already set, a POST
 * body that is not an object, a variable the host gives no value for, a value that cannot be read (a getter or a
 * Proxy that throws) and a value that is not a string, a finite number or a boolean each fail the cell; the reason
 * names the variable, never its value or the error a read threw.
 */
export function buildRequest(request: DashboardRequest, values: VariableValues): DashboardRequest {
  const { variables, ...plain } = request;
  if (variables === undefined) return request;
  const entries = Object.entries(variables);
  if (entries.length === 0) return plain;
  const where = `request ${String(request.method)} ${request.path}`;
  const added = entries.map(([key, name]) => {
    const read = readValue(values, name);
    if (read === UNREADABLE) throw new CellFailure(`${where}: the value of the variable ${name} cannot be read`);
    if (!read) throw new CellFailure(`${where}: the host gives no value for the variable ${name}`);
    const { value } = read;
    const plainValue = typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
    if (!plainValue) throw new CellFailure(`${where}: the value of the variable ${name} is not a string, a finite number or a boolean`);
    return [key, value as string | number | boolean] as const;
  });
  if (request.method === 'POST') {
    const body = request.body === undefined ? {} : request.body;
    if (!isPlainObject(body)) throw new CellFailure(`${where}: the body is not an object, so it cannot take the key ${added[0][0]}`);
    const taken = added.find(([key]) => Object.hasOwn(body, key));
    if (taken) throw new CellFailure(`${where}: key ${taken[0]} is already set`);
    return { ...plain, body: { ...body, ...Object.fromEntries(added) } };
  }
  const hash = request.path.indexOf('#');
  const beforeHash = hash < 0 ? request.path : request.path.slice(0, hash);
  const fragment = hash < 0 ? '' : request.path.slice(hash);
  const mark = beforeHash.indexOf('?');
  const query = mark < 0 ? '' : beforeHash.slice(mark + 1);
  const present = new URLSearchParams(query);
  const taken = added.find(([key]) => present.has(key));
  if (taken) throw new CellFailure(`${where}: key ${taken[0]} is already set`);
  const appended = new URLSearchParams(added.map(([key, value]) => [key, String(value)])).toString();
  const path = `${mark < 0 ? beforeHash : beforeHash.slice(0, mark)}?${query ? `${query}&` : ''}${appended}${fragment}`;
  return { ...plain, path };
}

/** The key a built request is held under: method, built path and built body. */
const keyOf = (request: DashboardRequest) => JSON.stringify([request.method, request.path, request.body ?? null]);

/** Sends a request through the host, with the same-origin and method checks before anything leaves the root. */
export function sendRequest(host: DashboardHost, request: DashboardRequest, origin: string): Promise<unknown> {
  if (request.method !== 'GET' && request.method !== 'POST') return Promise.reject(new CellFailure(`request method ${String(request.method)} is not GET or POST`));
  if (!isSameOriginPath(request.path, origin)) return Promise.reject(new CellFailure(`request ${quotedPath(request.path)} is not a same-origin path`));
  return withTimeout((signal) => host.request(request, signal));
}

/**
 * The shared requests of one dashboard load: each built request (method, built path and built body) is sent once,
 * when the first cell asks for it, and its answer is held until the load is dropped. A variable change builds a new
 * request for the shared requests that name it; the others keep their answer.
 */
export class SharedRequests {
  private readonly held = new Map<string, Promise<unknown>>();
  /** The held answers that ended in a rejection: a retry drops them, so the request goes out again. */
  private readonly rejected = new Set<Promise<unknown>>();

  constructor(
    private readonly requests: Record<string, DashboardRequest>,
    private readonly host: DashboardHost,
    private readonly origin: string,
  ) {}

  has(name: string): boolean {
    return Object.hasOwn(this.requests, name);
  }

  /** The variable names the shared request `name` depends on. */
  variablesOf(name: string): string[] {
    return this.has(name) ? Object.values(this.requests[name].variables ?? {}) : [];
  }

  get(name: string, values: VariableValues = NO_VALUES): Promise<unknown> {
    const request = this.has(name) ? this.requests[name] : undefined;
    if (!request) return Promise.reject(new CellFailure(`unknown source ${name}`));
    let built: DashboardRequest;
    try {
      built = buildRequest(request, values);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = keyOf(built);
    let answer = this.held.get(key);
    if (!answer) {
      const sent = sendRequest(this.host, built, this.origin);
      answer = sent;
      // Every dependent cell reads the same answer; one rejection is reported by each of them.
      sent.catch(() => this.rejected.add(sent));
      this.held.set(key, answer);
    }
    return answer;
  }

  /**
   * Drops the held answer of the shared request `name` for these values when it ended in a rejection, so the next
   * `get` sends it again, once, for every cell that reads it. An answer still on the way or a good one is kept.
   * Returns the dropped answer, so the caller can find every run that still waits on it.
   */
  forgetFailure(name: string, values: VariableValues = NO_VALUES): Promise<unknown> | undefined {
    if (!this.has(name)) return undefined;
    let key: string;
    try {
      key = keyOf(buildRequest(this.requests[name], values));
    } catch {
      return undefined;
    }
    const answer = this.held.get(key);
    if (!answer || !this.rejected.delete(answer)) return undefined;
    this.held.delete(key);
    return answer;
  }
}

/**
 * Runs one binding with the current variable values. `isLive` says whether this run is still the cell's current
 * one: false once the cell left or a newer run (a variable change) started; a result that arrives then is dropped.
 */
export async function runBinding({
  binding,
  host,
  shared,
  origin,
  values = NO_VALUES,
  isLive,
  onShared,
}: {
  binding: Binding;
  host: DashboardHost;
  shared: SharedRequests;
  origin: string;
  values?: VariableValues;
  isLive: () => boolean;
  /** Told the held answer of the shared request this run awaits. */
  onShared?: (answer: Promise<unknown>) => void;
}): Promise<BindingResult> {
  let transform;
  try {
    transform = compileTransform(binding.transform);
  } catch (error) {
    throw new CellFailure(`transform does not parse or check: ${error instanceof Error ? error.message : String(error)}`);
  }
  let variables: Record<string, unknown>;
  const form = formOf(binding);
  if (form === 'static') {
    variables = { params: (binding as { params?: object }).params ?? {} };
  } else {
    let response: unknown;
    try {
      if (form === 'own') {
        response = await sendRequest(host, buildRequest((binding as { request: DashboardRequest }).request, values), origin);
      } else {
        const { source } = binding as { source: string };
        if (!shared.has(source)) throw new CellFailure(`unknown source ${source}`);
        try {
          const answer = shared.get(source, values);
          onShared?.(answer);
          response = await answer;
        } catch (error) {
          // A refusal before sending stays a plain failure; anything the host or the timeout gave is a failed request.
          const Failure = error instanceof CellFailure ? CellFailure : RequestFailed;
          throw new Failure(`shared request ${source} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      if (!isLive()) return { dropped: true };
      if (error instanceof CellFailure) throw error;
      const { method, path } = (binding as { request: DashboardRequest }).request;
      throw new RequestFailed(`request ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isLive()) return { dropped: true };
    variables = form === 'own' ? { response } : { response, params: (binding as { params?: object }).params ?? {} };
  }
  try {
    return { dropped: false, data: transform.evaluate(variables) };
  } catch (error) {
    throw new CellFailure(`transform failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
