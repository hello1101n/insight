export function withoutPagingRepeats<T extends { id: string }>(
  items: readonly T[]
): T[] {
  const seen = new Set<string>();

  return items.filter(({ id }) => !seen.has(id) && seen.add(id));
}
