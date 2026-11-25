import { fetchWithAuth } from "@/api/fetch-with-auth";
import { normalizeSources } from "@/lib/identities/sources";
import { normalizePersonId } from "@/lib/metrics/entity";
import type { IdentityPerson } from "@/types/insight";

const BASE =
  (import.meta.env.VITE_IDENTITY_BASE as string | undefined) ??
  "/api/identity/v1";

export interface MeRole {
  role_id: string;
  name: string;
}

export type VisibilityPolicy = "org_chart" | "flat";

export interface MeResponse {
  person_id: string;
  insight_tenant_id: string;
  roles: MeRole[];
  visibility_policy?: VisibilityPolicy;
}
export async function getMe(): Promise<MeResponse> {
  const res = await fetchWithAuth(`${BASE}/me`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let me: MeResponse;
  try {
    me = (await res.json()) as MeResponse;
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (
    !me.person_id?.trim() ||
    !Array.isArray(me.roles) ||
    !me.roles.every(isMeRole)
  ) {
    throw new IdentityApiError(res.status, { error: "malformed_me" });
  }
  return me;
}

function isMeRole(role: unknown): role is MeRole {
  return (
    typeof role === "object" &&
    role !== null &&
    typeof (role as MeRole).role_id === "string" &&
    (role as MeRole).role_id.trim() !== ""
  );
}

export interface PersonSummary {
  person_id: string;
  provisional?: boolean;
  email?: string | null;
  username?: string | null;
  display_name?: string | null;
  job_title?: string | null;
  status?: string | null;
}

export interface AttentionItem {
  kind: string;
  source: string;
  source_id: string;
  account_id: string;
  email?: string | null;
  username?: string | null;
  display_name?: string | null;
  job_title?: string | null;
  department?: string | null;
  status?: string | null;
  manager_email?: string | null;
  bound_to?: string | null;
  candidates: PersonSummary[];
}

export interface ResolutionRates {
  observed: number;
  bound: number;
  pending: number;
  no_source_id: number;
  no_evidence: number;
  excluded: number;
}

export interface AttentionResponse {
  items: AttentionItem[];
  rates: ResolutionRates;
  truncated?: boolean;
  items_truncated?: boolean;
}

function sourceParam(sources: readonly string[]): string {
  const picked = normalizeSources(sources).map(encodeURIComponent);
  return picked.length > 0 ? `&source=${picked.join(",")}` : "";
}

function kindParam(kinds: readonly string[]): string {
  const picked = normalizeSources(kinds).map(encodeURIComponent);
  return picked.length > 0 ? `&kind=${picked.join(",")}` : "";
}

export const QUEUE_FIRST_PAGE = 200;

export const QUEUE_MAX_ITEMS = 1000;

export async function getAttention(
  limit: number = QUEUE_FIRST_PAGE,
  sources: readonly string[] = [],
  kinds: readonly string[] = []
): Promise<AttentionResponse> {
  const res = await fetchWithAuth(
    `${BASE}/resolution/attention?limit=${limit}${sourceParam(sources)}${kindParam(kinds)}`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let attention: AttentionResponse;
  try {
    attention = (await res.json()) as AttentionResponse;
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(attention.items) || attention.rates == null) {
    throw new IdentityApiError(res.status, { error: "malformed_attention" });
  }
  return attention;
}

export interface AccountMatch {
  source: string;
  source_id: string;
  account_id: string;
  email?: string | null;
  username?: string | null;
  display_name?: string | null;
  person?: PersonSummary | null;
  excluded?: boolean;
  bound_by_operator: boolean;
  address_holder?: PersonSummary | null;
}

export interface AccountSearchResponse {
  items: AccountMatch[];
  next_cursor?: string | null;
}

export async function searchAccounts(
  q: string,
  page: PageRequest = {},
  signal?: AbortSignal,
  sources: readonly string[] = []
): Promise<AccountSearchResponse> {
  const res = await fetchWithAuth(
    `${BASE}/resolution/accounts?q=${encodeURIComponent(q)}${pageParams(page)}${sourceParam(sources)}`,
    { signal }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  return (await res.json()) as AccountSearchResponse;
}

export async function listSources(signal?: AbortSignal): Promise<string[]> {
  const res = await fetchWithAuth(`${BASE}/resolution/sources`, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  const body = (await res.json()) as { items?: string[] };
  return Array.isArray(body.items) ? body.items : [];
}

export interface BindingHistoryEntry {
  person_id: string;
  person?: PersonSummary | null;
  author_person_id: string;
  author?: PersonSummary | null;
  by_operator: boolean;
  reason?: string | null;
  recorded_at: string;
}

export interface AccountOperation {
  operation_id: string;
  verb: string;
  author_person_id: string;
  author?: PersonSummary | null;
  comment?: string | null;
  accounts_touched: number;
  outcome?: string | null;
  recorded_at: string;
}

export interface AccountBinding {
  source: string;
  source_id: string;
  account_id: string;
  person_id?: string | null;
  history: BindingHistoryEntry[];
  operations?: AccountOperation[];
}

export async function getAccountBinding(ref: {
  source: string;
  source_id: string;
  account_id: string;
}): Promise<AccountBinding> {
  const path = [ref.source, ref.source_id, ref.account_id]
    .map(encodeURIComponent)
    .join("/");
  const res = await fetchWithAuth(`${BASE}/resolution/accounts/${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let binding: AccountBinding;
  try {
    binding = (await res.json()) as AccountBinding;
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(binding.history)) {
    throw new IdentityApiError(res.status, { error: "malformed_binding" });
  }
  return binding;
}

export interface WireAccountRef {
  source: string;
  source_id: string;
  id: string;
}

export function toWireAccountRef(account: {
  source: string;
  source_id: string;
  account_id: string;
}): WireAccountRef {
  return {
    source: account.source,
    source_id: account.source_id,
    id: account.account_id,
  };
}

export interface CorrectionItemResult {
  source: string;
  source_id: string;
  account_id: string;
  outcome: string;
}

export interface CorrectionResponse {
  applied: number;
  already_decided: number;
  items: CorrectionItemResult[];
  new_person_id?: string | null;
}

async function postCorrection(
  path: string,
  body: unknown
): Promise<CorrectionResponse> {
  const res = await fetchWithAuth(`${BASE}/resolution/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, errBody);
  }
  let outcome: CorrectionResponse;
  try {
    outcome = (await res.json()) as CorrectionResponse;
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(outcome.items)) {
    throw new IdentityApiError(res.status, { error: "malformed_correction" });
  }
  return outcome;
}

export async function bindAccount(args: {
  account: WireAccountRef;
  person_id: string;
  comment?: string;
}): Promise<CorrectionResponse> {
  return postCorrection("bind", {
    bindings: [{ account: args.account, person_id: args.person_id }],
    comment: args.comment ?? "",
  });
}

export interface WireBinding {
  account: WireAccountRef;
  person_id: string;
}

export const MAX_BINDINGS_PER_CALL = 1000;

export async function bindAccounts(args: {
  bindings: WireBinding[];
  comment?: string;
}): Promise<CorrectionResponse> {
  return postCorrection("bind", {
    bindings: args.bindings,
    comment: args.comment ?? "",
  });
}

export async function mergePersons(args: {
  source_person_id: string;
  target_person_id: string;
  comment?: string;
}): Promise<CorrectionResponse> {
  return postCorrection("merge", {
    source_person_id: args.source_person_id,
    target_person_id: args.target_person_id,
    comment: args.comment ?? "",
  });
}

export async function detachAccount(args: {
  account: WireAccountRef;
  comment?: string;
}): Promise<CorrectionResponse> {
  return postCorrection("detach", {
    account: args.account,
    comment: args.comment ?? "",
  });
}

export async function excludeAccount(args: {
  account: WireAccountRef;
  comment?: string;
}): Promise<CorrectionResponse> {
  return postCorrection("exclude", {
    account: args.account,
    comment: args.comment ?? "",
  });
}

export interface PersonSearchResponse {
  items: PersonSummary[];
  next_cursor?: string | null;
}

export interface PeopleListItem {
  person_id: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  email: string | null;
  attributes: Record<string, string>;
  manager_person_id: string | null;
  manager_name: string | null;
}

export interface PeopleListResponse {
  items: PeopleListItem[];
  next_cursor?: string | null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isPeopleListItem(value: unknown): value is PeopleListItem {
  if (typeof value !== "object" || value === null) return false;
  const person = value as Record<string, unknown>;
  const attributes = person.attributes;
  return (
    typeof person.person_id === "string" &&
    isNullableString(person.display_name) &&
    isNullableString(person.first_name) &&
    isNullableString(person.last_name) &&
    isNullableString(person.username) &&
    isNullableString(person.email) &&
    typeof attributes === "object" &&
    attributes !== null &&
    !Array.isArray(attributes) &&
    Object.values(attributes).every(
      (attribute) => typeof attribute === "string"
    ) &&
    isNullableString(person.manager_person_id) &&
    isNullableString(person.manager_name)
  );
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

export interface PeopleListRequest extends PageRequest {
  q?: string;
  visibility?: "caller" | "tenant";
}

function pageParams(page: PageRequest): string {
  const params = new URLSearchParams();
  if (page.cursor) params.set("cursor", page.cursor);
  if (page.limit != null) params.set("limit", String(page.limit));
  const query = params.toString();
  return query ? `&${query}` : "";
}

export async function listPeople(
  page: PeopleListRequest = {},
  signal?: AbortSignal
): Promise<PeopleListResponse> {
  const params = new URLSearchParams();
  if (page.visibility) params.set("visibility", page.visibility);
  if (page.q) params.set("q", page.q);
  if (page.cursor) params.set("cursor", page.cursor);
  if (page.limit != null) params.set("limit", String(page.limit));
  const query = params.toString();
  const url = `${BASE}/people${query ? `?${query}` : ""}`;
  const res = signal
    ? await fetchWithAuth(url, { signal })
    : await fetchWithAuth(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let listed: PeopleListResponse;
  try {
    listed = (await res.json()) as PeopleListResponse;
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(listed.items) || !listed.items.every(isPeopleListItem)) {
    throw new IdentityApiError(res.status, { error: "malformed_roster" });
  }
  return listed;
}

export async function searchPersons(
  q: string,
  page: PageRequest = {},
  signal?: AbortSignal
): Promise<PersonSearchResponse> {
  const res = await fetchWithAuth(
    `${BASE}/persons?q=${encodeURIComponent(q)}${pageParams(page)}`,
    { signal }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let found: PersonSearchResponse;
  try {
    found = (await res.json()) as PersonSearchResponse;
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(found.items)) {
    throw new IdentityApiError(res.status, { error: "malformed_search" });
  }
  return found;
}

export async function listVisiblePersons(
  page: PageRequest & { q?: string } = {}
): Promise<PersonSearchResponse> {
  const params = new URLSearchParams();
  if (page.q) params.set("q", page.q);
  if (page.cursor) params.set("cursor", page.cursor);
  if (page.limit != null) params.set("limit", String(page.limit));
  const query = params.toString();
  const res = await fetchWithAuth(
    `${BASE}/visible-persons${query ? `?${query}` : ""}`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let listed: PersonSearchResponse;
  try {
    listed = (await res.json()) as PersonSearchResponse;
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(listed.items)) {
    throw new IdentityApiError(res.status, { error: "malformed_roster" });
  }
  return listed;
}

export interface PersonAccountEntry {
  source: string;
  source_id: string;
  account_id: string;
  email?: string | null;
  username?: string | null;
  bound_by_operator: boolean;
}

export async function getPersonAccounts(
  personId: string
): Promise<{ person_id: string; accounts: PersonAccountEntry[] }> {
  const res = await fetchWithAuth(
    `${BASE}/resolution/persons/${encodeURIComponent(personId)}/accounts`
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let owned: { person_id: string; accounts: PersonAccountEntry[] };
  try {
    owned = (await res.json()) as typeof owned;
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(owned.accounts)) {
    throw new IdentityApiError(res.status, { error: "malformed_accounts" });
  }
  return owned;
}

export class IdentityApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Identity API ${status}`);
    this.name = "IdentityApiError";
    this.status = status;
    this.body = body;
  }
}

function toIdentityPerson(p: PeopleListItem): IdentityPerson {
  return {
    person_id: p.person_id,
    email: p.email ?? "",
    display_name: p.display_name ?? "",
    first_name: p.first_name ?? "",
    last_name: p.last_name ?? "",
    department: p.attributes.department ?? "",
    division: p.attributes.division ?? "",
    job_title: p.attributes.job_title ?? "",
    status: p.attributes.status ?? "",
    username: p.username ?? "",
    parent_email: null,
    parent_id: null,
    parent_person_id: p.manager_person_id,
    supervisor_email: null,
    supervisor_name: null,
    subordinates: [],
  };
}

export async function getPerson(
  personId: string,
  signal?: AbortSignal
): Promise<IdentityPerson> {
  const id = normalizePersonId(personId);
  const url = `${BASE}/people/${encodeURIComponent(id)}`;
  const res = signal
    ? await fetchWithAuth(url, { signal })
    : await fetchWithAuth(url);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let person: unknown;
  try {
    person = await res.json();
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!isPeopleListItem(person)) {
    throw new IdentityApiError(res.status, { error: "malformed_person" });
  }
  return toIdentityPerson(person);
}

export interface PersonRole {
  person_role_id: string;
  person_id: string;
  role_id: string;
  valid_from?: string;
  valid_to?: string | null;
  reason?: string | null;
}

export async function listPersonRoles(
  personId: string,
  signal?: AbortSignal
): Promise<PersonRole[]> {
  const url = `${BASE}/person-roles?person=${encodeURIComponent(
    personId
  )}&active=true`;
  const res = await fetchWithAuth(url, signal ? { signal } : undefined);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let held: { items?: unknown };
  try {
    held = (await res.json()) as { items?: unknown };
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(held.items)) {
    throw new IdentityApiError(res.status, {
      error: "malformed_person_roles",
    });
  }
  return held.items as PersonRole[];
}

export const ROLE_HOLDERS_MAX = 500;

export type RoleHolders =
  | { complete: true; personIds: ReadonlySet<string> }
  | { complete: false };

export async function listRoleHolders(
  roleId: string,
  signal?: AbortSignal
): Promise<RoleHolders> {
  const query = new URLSearchParams({
    role: roleId,
    active: "true",
    limit: String(ROLE_HOLDERS_MAX),
  });
  const url = `${BASE}/person-roles?${query}`;
  const res = await fetchWithAuth(url, signal ? { signal } : undefined);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let held: { items?: unknown };
  try {
    held = (await res.json()) as { items?: unknown };
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(held.items)) {
    throw new IdentityApiError(res.status, {
      error: "malformed_person_roles",
    });
  }
  const assignments = held.items as PersonRole[];
  if (assignments.length >= ROLE_HOLDERS_MAX) return { complete: false };

  return {
    complete: true,
    personIds: new Set(
      assignments.map((role) => normalizePersonId(role.person_id))
    ),
  };
}

export async function grantPersonRole(args: {
  person_id: string;
  role_id: string;
  reason?: string;
}): Promise<PersonRole> {
  const res = await fetchWithAuth(`${BASE}/person-roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
  let granted: PersonRole;
  try {
    granted = (await res.json()) as PersonRole;
  } catch {
    throw new IdentityApiError(res.status, { error: "invalid_json" });
  }
  return granted;
}

export async function revokePersonRole(personRoleId: string): Promise<void> {
  const res = await fetchWithAuth(
    `${BASE}/person-roles/${encodeURIComponent(personRoleId)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new IdentityApiError(res.status, body);
  }
}
