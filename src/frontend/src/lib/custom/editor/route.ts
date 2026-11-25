import type { EditableKind } from "@/api/custom-client";

import { NOUNS } from "./kinds";

const KIND_PATTERNS = {
  new: /^\/dashboards\/new\/([^/]+)/,
  edit: /^\/dashboards\/edit\/([^/]+)/,
} as const;

export function kindFromPath(
  pathname: string,
  under: "new" | "edit"
): EditableKind | undefined {
  const match = pathname.match(KIND_PATTERNS[under]);
  const named = match ? decodeURIComponent(match[1]) : "";

  return Object.hasOwn(NOUNS, named) ? (named as EditableKind) : undefined;
}

export function idFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/dashboards\/edit\/[^/]+\/([^/]+)/);

  return match ? decodeURIComponent(match[1]) : undefined;
}
