const CARRIED_BY: Record<string, string> = {
  "git.code_lines": "git.commits",
  "git.lines_added": "git.commits",
  "git.lines_removed": "git.commits",
  "git.default_branch_code_lines": "git.default_branch_commits",
  "git.default_branch_lines_added": "git.default_branch_commits",
  "git.default_branch_lines_removed": "git.default_branch_commits",
  "git.non_default_branch_code_lines": "git.non_default_branch_commits",
  "git.non_default_branch_lines_added": "git.non_default_branch_commits",
  "git.non_default_branch_lines_removed": "git.non_default_branch_commits",
};

export function evidenceMetricFor(
  key: string,
  narrowedBy: readonly string[] = [],
  declared: (metricKey: string) => readonly string[] | undefined = () =>
    undefined
): string {
  const carrier = CARRIED_BY[key];
  if (!carrier) return key;
  if (narrowedBy.length === 0) return carrier;
  const dimensions = declared(carrier);
  return dimensions && narrowedBy.every((d) => dimensions.includes(d))
    ? carrier
    : key;
}

export function evidenceCarriers(keys: readonly string[]): string[] {
  const carriers = keys
    .map((key) => CARRIED_BY[key])
    .filter((carrier): carrier is string => carrier != null);
  return [...new Set(carriers)];
}
