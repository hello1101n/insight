export function dimensionName(dimension: string): string {
  const label = dimension.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function dimensionDescription(dimension: string): string {
  return dimension.replaceAll("_", " ");
}

const BREAKDOWN_HEADINGS: ReadonlyMap<string, string> = new Map([
  ["branch_scope", "Default branch vs other"],
]);

export function breakdownHeading(dimensions: readonly string[]): string {
  const [only] = dimensions;
  const curated =
    dimensions.length === 1 && only != null ? BREAKDOWN_HEADINGS.get(only) : undefined;
  return curated ?? `By ${dimensions.map(dimensionDescription).join(" / ")}`;
}
