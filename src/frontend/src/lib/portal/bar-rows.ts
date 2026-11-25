export interface BarSegment {
  seed: string;
  label: string;
  value: number;
}

export interface BarRow {
  key: string;
  label: string;
  value: number;
  pct: number;
  href?: string;
  segments?: BarSegment[];
}

export interface BarEntry {
  label: string;
  value: number;
  href?: string;
  split?: Map<string, BarSegment>;
}

export const UNSPLIT_SEGMENT = "unsplit";

const SEGMENT_ORDER: Record<string, readonly string[]> = {
  branch_scope: ["default", "non_default"],
};

function segmentsOf(
  split: Map<string, BarSegment>,
  splitBy: string | undefined
): BarSegment[] {
  const declared = splitBy ? SEGMENT_ORDER[splitBy] : undefined;
  const segments = [...split.values()];
  if (!declared) return segments.sort((a, b) => b.value - a.value);
  const rank = (seed: string) => {
    const at = declared.indexOf(seed);
    return at === -1 ? declared.length : at;
  };
  return segments.sort((a, b) => rank(a.seed) - rank(b.seed) || b.value - a.value);
}

export function toBarRows(
  bucket: Map<string, BarEntry>,
  splitBy?: string
): BarRow[] {
  const total =
    [...bucket.values()].reduce((sum, entry) => sum + entry.value, 0) || 1;
  return [...bucket.entries()]
    .map(([key, { label, value, split, href }]) => ({
      key,
      label,
      value,
      href,
      segments: split ? segmentsOf(split, splitBy) : undefined,
      pct: (value / total) * 100,
    }))
    .sort((a, b) => b.value - a.value);
}

export function labelForDimensionValue(
  dimension: string | null,
  value: string,
  ...sources: ReadonlyArray<
    ReadonlyMap<
      string,
      {
        breakdown?: { values: readonly { dimensions: readonly DimensionRef[] }[] };
        rollup?: { values: readonly { dimensions: readonly DimensionRef[] }[] };
      }
    >
  >
): string | undefined {
  if (!dimension) return undefined;
  for (const byKey of sources) {
    for (const result of byKey.values()) {
      for (const view of [result.breakdown, result.rollup]) {
        for (const row of view?.values ?? []) {
          const dim = row.dimensions.find((d) => d.key === dimension);
          if (dim?.value === value && dim.label?.trim()) return dim.label.trim();
        }
      }
    }
  }
  return undefined;
}

interface DimensionRef {
  key: string;
  value: string;
  label?: string | null;
}
