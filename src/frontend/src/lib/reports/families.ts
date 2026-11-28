const FAMILY_NAMES: Record<string, string> = {
  git: "Development · Git",
  tasks: "Development · Delivery",
  collab: "Collaboration",
  ci: "CI",
  wiki: "Knowledge / Wiki",
  ai: "AI",
  personal: "Custom metrics",
};

export function familyOf(metricKey: string): string {
  return metricKey.split(".")[0] ?? "";
}

export function familyName(family: string): string {
  return FAMILY_NAMES[family] ?? family;
}

export interface MetricFamily<T> {
  family: string;
  name: string;
  metrics: T[];
}

export function byFamily<T extends { metric_key: string }>(
  metrics: readonly T[]
): MetricFamily<T>[] {
  const known = Object.keys(FAMILY_NAMES);
  const grouped = new Map<string, T[]>();
  for (const metric of metrics) {
    const family = familyOf(metric.metric_key);
    grouped.set(family, [...(grouped.get(family) ?? []), metric]);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => {
      const ai = known.indexOf(a);
      const bi = known.indexOf(b);
      if (ai === bi) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    })
    .map(([family, group]) => ({
      family,
      name: familyName(family),
      metrics: group,
    }));
}
