import { fetchWithAuth } from "@/api/fetch-with-auth";

export const BASE =
  (import.meta.env.VITE_API_BASE_V3 as string | undefined) ?? "/api/v3/v1";

export type * from "@/api/custom-types";
import type {
  DashboardListed,
  DashboardWidget,
  Dataset,
  DatasetRecords,
  Dependents,
  DrilldownPage,
  DrilldownRequest,
  Listed,
  ListedPage,
  MetricListed,
  WidgetListed,
  DatasetListed,
  RecordPage,
  MetricResult,
  OrphanedDashboard,
  StoredMetric,
  StoredWidget,
  Widget,
  ChatReply,
  ChatTurn,
  DashboardRead,
  DashboardResponse,
  DefinitionResponse,
  Folder,
  FolderFilter,
  FolderList,
  Grant,
  GrantLevel,
  Grantee,
  MetricDefinition,
  OrphanedFolder,
  PinList,
  TagList,
} from "@/api/custom-types";

export const JSON_HEADERS = { "Content-Type": "application/json" };

export class CustomApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Custom API ${status}`);
    this.name = "CustomApiError";
    this.status = status;
    this.body = body;
  }
}

export function isBusy(error: unknown): boolean {
  return error instanceof CustomApiError && error.status === 429;
}

export function isDenied(error: unknown): boolean {
  return error instanceof CustomApiError && error.status === 403;
}

export async function ensureOk(res: Response): Promise<void> {
  if (!res.ok) {
    throw new CustomApiError(res.status, await res.json().catch(() => null));
  }
}

export async function readJson<T>(res: Response): Promise<T> {
  await ensureOk(res);
  return (await res.json()) as T;
}

function named(name: string): string {
  if (name === "") {
    throw new CustomApiError(400, { detail: "A name is required." });
  }
  return encodeURIComponent(name);
}

export type DefinitionKind = "metrics" | "widgets" | "dashboards";

export type EditableKind = DefinitionKind | "datasets";

export async function deleteDefinition(
  kind: DefinitionKind,
  id: string
): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/${kind}/${named(id)}`, {
    method: "DELETE",
  });
  await ensureOk(res);
}

export async function fetchDefinition<T = unknown>(
  kind: DefinitionKind,
  id: string
): Promise<DefinitionResponse<T>> {
  const res = await fetchWithAuth(`${BASE}/${kind}/${named(id)}`);
  return readJson<DefinitionResponse<T>>(res);
}

export async function createDefinition(
  kind: DefinitionKind,
  name: string,
  body: unknown
): Promise<string> {
  const res = await fetchWithAuth(`${BASE}/${kind}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, body }),
  });
  const made = await readJson<{ id: string }>(res);

  return made.id;
}

export async function putDefinition(
  kind: DefinitionKind,
  id: string,
  name: string,
  body: unknown
): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/${kind}/${named(id)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, body }),
  });
  await ensureOk(res);
}

export async function renameDashboard(id: string, to: string): Promise<void> {
  const stored = await fetchDefinition<Record<string, unknown>>(
    "dashboards",
    id
  );
  await putDefinition("dashboards", id, to, { ...stored.body, title: to });
}

export const DEFINITION_NAME_MAX = 128;

export type OwnedFilter = "me" | "shared";

export type DashboardOrder = "name" | "recent";

export interface PageRequest {
  search?: string;
  limit?: number;
  offset?: number;
  folder?: FolderFilter;
  tags?: string[];
  owned?: OwnedFilter;
  sort?: DashboardOrder;
}

function pageQuery({
  search = "",
  limit,
  offset,
  folder,
  tags = [],
  owned,
  sort,
}: PageRequest): string {
  const query = new URLSearchParams();
  if (search) query.set("q", search);
  if (limit !== undefined) query.set("limit", String(limit));
  if (offset) query.set("offset", String(offset));
  if (folder) query.set("folder", folder);
  for (const tag of tags) query.append("tag", tag);
  if (owned) query.set("owned", owned);
  if (sort) query.set("sort", sort);
  const asked = query.toString();

  return asked ? `?${asked}` : "";
}

export async function fetchDashboards(
  page: PageRequest = {}
): Promise<ListedPage<DashboardListed>> {
  const res = await fetchWithAuth(`${BASE}/dashboards${pageQuery(page)}`);
  return readJson<ListedPage<DashboardListed>>(res);
}

export async function fetchDashboardRead(id: string): Promise<DashboardRead> {
  const res = await fetchWithAuth(`${BASE}/dashboards/${named(id)}`);
  const read = await readJson<DashboardResponse>(res);
  const shown: DashboardRead = {
    name: read.name,
    body: read.body,
    tags: read.tags ?? [],
    ownerPersonId: read.owner_person_id,
    ownerName: read.owner_name ?? null,
    access: read.access,
    visibility: read.visibility ?? null,
    folders: read.folders ?? [],
    carries: read.carries ?? false,
  };

  return read.updated_at ? { ...shown, updatedAt: read.updated_at } : shown;
}

export const TAG_NAME_MAX = 32;
export const DASHBOARD_TAGS_MAX = 10;

export async function fetchTags(): Promise<TagList> {
  const res = await fetchWithAuth(`${BASE}/tags`);
  return readJson<TagList>(res);
}

export async function setDashboardTags(
  id: string,
  tags: string[]
): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/dashboards/${named(id)}/tags`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ tags }),
  });
  await ensureOk(res);
}

export async function duplicateDashboard(
  id: string,
  name: string
): Promise<string> {
  const res = await fetchWithAuth(`${BASE}/dashboards/${named(id)}/duplicate`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  const made = await readJson<{ id: string }>(res);

  return made.id;
}

export async function fetchPins(): Promise<Listed[]> {
  const res = await fetchWithAuth(`${BASE}/pins`);
  const read = await readJson<PinList>(res);

  return read.pins;
}

export async function pinDashboard(id: string): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/pins/${named(id)}`, {
    method: "PUT",
  });
  await ensureOk(res);
}

export async function unpinDashboard(id: string): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/pins/${named(id)}`, {
    method: "DELETE",
  });
  await ensureOk(res);
}

export const EVERYONE: Grantee = "everyone";

export interface GrantTarget {
  kind: "dashboards" | "folders";
  id: string;
}

function grantsPath({ kind, id }: GrantTarget): string {
  return `${BASE}/${kind}/${named(id)}/grants`;
}

export async function fetchGrants(target: GrantTarget): Promise<Grant[]> {
  const res = await fetchWithAuth(grantsPath(target));
  const read = await readJson<{ items: Grant[] }>(res);

  return read.items;
}

export async function putGrant(
  target: GrantTarget,
  grantee: Grantee,
  level: GrantLevel
): Promise<void> {
  const res = await fetchWithAuth(`${grantsPath(target)}/${named(grantee)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ level }),
  });
  await ensureOk(res);
}

export async function deleteGrant(
  target: GrantTarget,
  grantee: Grantee
): Promise<void> {
  const res = await fetchWithAuth(`${grantsPath(target)}/${named(grantee)}`, {
    method: "DELETE",
  });
  await ensureOk(res);
}

export async function fetchOrphanedDashboards(
  page: Pick<PageRequest, "limit" | "offset"> = {}
): Promise<ListedPage<OrphanedDashboard>> {
  const res = await fetchWithAuth(
    `${BASE}/orphaned-dashboards${pageQuery(page)}`
  );
  return readJson<ListedPage<OrphanedDashboard>>(res);
}

export async function fetchOrphanedFolders(
  page: Pick<PageRequest, "limit" | "offset"> = {}
): Promise<ListedPage<OrphanedFolder>> {
  const res = await fetchWithAuth(`${BASE}/orphaned-folders${pageQuery(page)}`);
  return readJson<ListedPage<OrphanedFolder>>(res);
}

export type OrphanKind = "dashboards" | "folders";

export async function transferOrphan(
  kind: OrphanKind,
  id: string,
  to: string
): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/${kind}/${named(id)}/transfer`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ to }),
  });
  await ensureOk(res);
}

export const FOLDER_NAME_MAX = 64;

export async function fetchFolders(): Promise<FolderList> {
  const res = await fetchWithAuth(`${BASE}/folders`);
  return readJson<FolderList>(res);
}

export async function createFolder(name: string): Promise<Folder> {
  const res = await fetchWithAuth(`${BASE}/folders`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  return readJson<Folder>(res);
}

export async function renameFolder(id: string, name: string): Promise<Folder> {
  const res = await fetchWithAuth(`${BASE}/folders/${named(id)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });
  return readJson<Folder>(res);
}

export async function deleteFolder(id: string): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/folders/${named(id)}`, {
    method: "DELETE",
  });
  await ensureOk(res);
}

function entryPath(folder: string, dashboard: string): string {
  return `${BASE}/folders/${named(folder)}/dashboards/${named(dashboard)}`;
}

export async function addToFolder(
  folder: string,
  dashboard: string
): Promise<{ carries: boolean }> {
  const res = await fetchWithAuth(entryPath(folder, dashboard), {
    method: "PUT",
  });
  return readJson<{ carries: boolean }>(res);
}

export async function removeFromFolder(
  folder: string,
  dashboard: string
): Promise<void> {
  const res = await fetchWithAuth(entryPath(folder, dashboard), {
    method: "DELETE",
  });
  await ensureOk(res);
}

export async function fetchMetrics(
  page: PageRequest = {}
): Promise<ListedPage<MetricListed>> {
  const res = await fetchWithAuth(`${BASE}/metrics${pageQuery(page)}`);
  return readJson<ListedPage<MetricListed>>(res);
}

export async function fetchMetric(id: string): Promise<StoredMetric> {
  const read = await fetchDefinition<MetricDefinition>("metrics", id);

  return { name: read.name, definition: read.body, clock: read.clock };
}

export async function fetchWidgets(
  page: PageRequest = {}
): Promise<ListedPage<WidgetListed>> {
  const res = await fetchWithAuth(`${BASE}/widgets${pageQuery(page)}`);
  return readJson<ListedPage<WidgetListed>>(res);
}

export async function fetchWidget(id: string): Promise<StoredWidget> {
  const read = await fetchDefinition<Widget>("widgets", id);

  return { name: read.name, widget: read.body };
}

export interface NamePage {
  names: string[];
  items: Omit<DatasetListed, "id">[];
  total: number;
}

export async function fetchDatasetNames(
  page: PageRequest = {}
): Promise<NamePage> {
  const res = await fetchWithAuth(`${BASE}/datasets${pageQuery(page)}`);
  return readJson<NamePage>(res);
}

export async function fetchDataset(name: string): Promise<Dataset> {
  const res = await fetchWithAuth(`${BASE}/datasets/${named(name)}`);
  return readJson<Dataset>(res);
}

export async function fetchDatasetRecords(
  name: string,
  page: RecordPage
): Promise<DatasetRecords> {
  const query = new URLSearchParams();
  if (page.limit !== undefined) query.set("limit", String(page.limit));
  if (page.offset) query.set("offset", String(page.offset));
  if (page.orderBy) query.set("order_by", page.orderBy);
  if (page.descending !== undefined) {
    query.set("direction", page.descending ? "desc" : "asc");
  }
  const res = await fetchWithAuth(
    `${BASE}/datasets/${named(name)}/records?${query}`
  );

  return readJson<DatasetRecords>(res);
}

export async function fetchDependents(
  kind: DefinitionKind,
  id: string
): Promise<Dependents> {
  const res = await fetchWithAuth(`${BASE}/${kind}/${named(id)}/dependents`);
  return readJson<Dependents>(res);
}

export async function fetchDatasetDependents(name: string): Promise<string[]> {
  const res = await fetchWithAuth(`${BASE}/datasets/${named(name)}/dependents`);
  const read = await readJson<{ metrics: string[] }>(res);

  return read.metrics;
}

export async function putDataset(
  name: string,
  declaration: unknown
): Promise<Dataset> {
  const res = await fetchWithAuth(`${BASE}/datasets/${named(name)}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(declaration),
  });
  return readJson<Dataset>(res);
}

export async function deleteDataset(name: string): Promise<void> {
  const res = await fetchWithAuth(`${BASE}/datasets/${named(name)}`, {
    method: "DELETE",
  });
  await ensureOk(res);
}

export interface RunOptions {
  range?: string;
  bucket?: boolean;
}

export async function runMetric(
  id: string,
  options?: RunOptions
): Promise<MetricResult> {
  const res = await fetchWithAuth(`${BASE}/metrics/${named(id)}/run`, {
    method: "POST",
    ...(options
      ? { headers: JSON_HEADERS, body: JSON.stringify(options) }
      : {}),
  });
  return readJson<MetricResult>(res);
}

export async function fetchDashboardWidgets(
  id: string
): Promise<DashboardWidget[]> {
  const res = await fetchWithAuth(`${BASE}/dashboards/${named(id)}/widgets`);
  const read = await readJson<{ items: DashboardWidget[] }>(res);

  return read.items;
}

export function dashboardWidgetPath(dashboard: string, widget: string): string {
  return `${BASE}/dashboards/${named(dashboard)}/widgets/${named(widget)}`;
}

export async function runDashboardWidget(
  dashboard: string,
  widget: string,
  options?: RunOptions
): Promise<MetricResult> {
  const res = await fetchWithAuth(
    `${dashboardWidgetPath(dashboard, widget)}/run`,
    {
      method: "POST",
      ...(options
        ? { headers: JSON_HEADERS, body: JSON.stringify(options) }
        : {}),
    }
  );
  return readJson<MetricResult>(res);
}

export async function fetchDashboardDrilldownPage(
  dashboard: string,
  widget: string,
  request: DrilldownRequest,
  signal?: AbortSignal
): Promise<DrilldownPage> {
  const res = await fetchWithAuth(
    `${dashboardWidgetPath(dashboard, widget)}/drilldown`,
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(request),
      signal,
    }
  );
  return readJson<DrilldownPage>(res);
}

export async function sendChat(
  message: string,
  history: ChatTurn[] = []
): Promise<ChatReply> {
  const res = await fetchWithAuth(`${BASE}/chat`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ message, history }),
  });
  return readJson<ChatReply>(res);
}
