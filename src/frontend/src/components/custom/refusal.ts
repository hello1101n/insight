import { CustomApiError } from "@/api/custom-client";

interface Said {
  description?: string;
}

interface Refusal {
  detail?: string;
  context?: {
    reason?: string;
    field_violations?: Said[];
    violations?: Said[];
  };
}

const DENIALS = new Map([
  [
    "only the owner or an editor can change this dashboard",
    "Only the owner or an editor can change this dashboard.",
  ],
  [
    "only the owner can delete this dashboard",
    "Only the owner can delete this dashboard.",
  ],
  [
    "only the owner or an editor granted this dashboard directly or through everyone can share it",
    "Editors through a folder can't share this dashboard.",
  ],
  [
    "only the owner or an editor can change this folder",
    "Only the owner or an editor can change this folder.",
  ],
  [
    "only the owner can delete this folder",
    "Only the owner can delete this folder.",
  ],
  [
    "admin role required for this operation",
    "Only an administrator can do this.",
  ],
]);

export function refusal(error: unknown, fallback: string): string {
  if (!(error instanceof CustomApiError)) return fallback;

  const body = error.body as Refusal | null;
  const reason = body?.context?.reason;
  const said =
    (reason ? DENIALS.get(reason) : undefined) ??
    body?.context?.field_violations?.[0]?.description ??
    body?.context?.violations?.[0]?.description;

  return said ?? body?.detail ?? fallback;
}
