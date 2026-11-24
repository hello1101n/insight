import { fetchWithAuth } from "@/api/fetch-with-auth";

const BASE =
  (import.meta.env.VITE_PREVIEWS_BASE as string | undefined) ??
  "/api/previews/v1";

export interface Experiment {
  name: string;
  tag: string;
  url: string;
  creator: string;
  createdAt?: string | null;
  expiresAt?: string | null;
  status: string;
}

export interface ExperimentListResponse {
  experiments: Experiment[];
  liveCount: number;
  cap: number;
}

export interface ImageListResponse {
  configured: boolean;
  tags: string[];
}

export interface CreateExperimentRequest {
  name: string;
  tag: string;
  ttlDays?: number;
}

export class PreviewsApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Previews API ${status}`);
    this.name = "PreviewsApiError";
    this.status = status;
    this.body = body;
  }
}

async function failure(res: Response): Promise<PreviewsApiError> {
  const body = await res.json().catch(() => null);
  return new PreviewsApiError(res.status, body);
}

export async function listExperiments(): Promise<ExperimentListResponse> {
  const res = await fetchWithAuth(`${BASE}/experiments`);
  if (!res.ok) throw await failure(res);
  let listed: ExperimentListResponse;
  try {
    listed = (await res.json()) as ExperimentListResponse;
  } catch {
    throw new PreviewsApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(listed.experiments)) {
    throw new PreviewsApiError(res.status, { error: "malformed_experiments" });
  }
  return listed;
}

export async function listImages(): Promise<ImageListResponse> {
  const res = await fetchWithAuth(`${BASE}/images`);
  if (!res.ok) throw await failure(res);
  let listed: ImageListResponse;
  try {
    listed = (await res.json()) as ImageListResponse;
  } catch {
    throw new PreviewsApiError(res.status, { error: "invalid_json" });
  }
  if (!Array.isArray(listed.tags)) {
    throw new PreviewsApiError(res.status, { error: "malformed_tags" });
  }
  return listed;
}

export async function createExperiment(
  req: CreateExperimentRequest
): Promise<Experiment> {
  const res = await fetchWithAuth(`${BASE}/experiments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await failure(res);
  try {
    return (await res.json()) as Experiment;
  } catch {
    throw new PreviewsApiError(res.status, { error: "invalid_json" });
  }
}

export async function deleteExperiment(name: string): Promise<void> {
  const res = await fetchWithAuth(
    `${BASE}/experiments/${encodeURIComponent(name)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw await failure(res);
}
