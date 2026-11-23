export function dimensionName(dimension: string): string {
  const label = dimension.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function dimensionDescription(dimension: string): string {
  return dimension.replaceAll("_", " ");
}

const BREAKDOWN_HEADINGS: Readonly<Record<string, string>> = {
  branch_scope: "Default branch vs other",
};

export function breakdownHeading(dimensions: readonly string[]): string {
  const [only] = dimensions;
  if (dimensions.length === 1 && only && Object.hasOwn(BREAKDOWN_HEADINGS, only)) {
    return BREAKDOWN_HEADINGS[only];
  }
  return `By ${dimensions.map(dimensionDescription).join(" / ")}`;
}
