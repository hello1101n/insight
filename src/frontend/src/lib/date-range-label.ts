function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function formatRange(fromIso: string, toIso: string): string {
  const from = parseIso(fromIso);
  const to = parseIso(toIso);
  const thisYear = new Date().getFullYear();
  const needsYear =
    from.getFullYear() !== to.getFullYear() ||
    from.getFullYear() !== thisYear ||
    to.getFullYear() !== thisYear;
  const opts: Intl.DateTimeFormatOptions = needsYear
    ? { day: "numeric", month: "short", year: "numeric" }
    : { day: "numeric", month: "short" };
  return `${from.toLocaleDateString("en-GB", opts)} – ${to.toLocaleDateString("en-GB", opts)}`;
}
