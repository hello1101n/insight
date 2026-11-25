import type { MetricDefinitionListResponse } from "@/api/metric-definitions-client";
import { availableSlices, type SliceDim } from "@/lib/insight/slices";
import type { SliceAttr } from "@/lib/insight/slices";

export type CohortSource = "catalog" | "roster" | "none";

export interface CohortOptions {
  dims: SliceDim[];
  source: CohortSource;
}

interface CatalogAttribute {
  id: string;
  label: string;
}

export function catalogAttributes(
  response: MetricDefinitionListResponse | undefined
): CatalogAttribute[] {
  const raw = (response as { comparison_attributes?: unknown } | undefined)
    ?.comparison_attributes;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, label } = entry as { id?: unknown; label?: unknown };
    if (typeof id !== "string" || !id) return [];
    if (typeof label !== "string" || !label) return [];
    return [{ id, label }];
  });
}

export function cohortOptions(
  catalog: readonly CatalogAttribute[],
  roster: Iterable<Record<string, SliceAttr>>
): CohortOptions {
  if (catalog.length > 0) {
    return {
      dims: catalog.map((a) => ({ key: a.id, label: a.label })),
      source: "catalog",
    };
  }
  const dims = availableSlices(roster);
  return { dims, source: dims.length > 0 ? "roster" : "none" };
}
