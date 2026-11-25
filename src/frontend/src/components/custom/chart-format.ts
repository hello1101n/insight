const COMPACT = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const GROUPED = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
  signDisplay: "negative",
});
const GROUPED_SMALL = new Intl.NumberFormat("en", {
  maximumFractionDigits: 2,
  signDisplay: "negative",
});
const DAY = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const DAY_IN_YEAR = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const TICK_CHARS = 14;

export function compactNumber(value: unknown, unit = ""): string {
  const number = toNumber(value);
  return number === null ? blank(value) : `${COMPACT.format(number)}${unit}`;
}

export function groupedNumber(value: unknown, unit = ""): string {
  const number = toNumber(value);
  if (number === null) return blank(value);

  const format = Math.abs(number) < 10 ? GROUPED_SMALL : GROUPED;
  return `${format.format(number)}${unit}`;
}

export function unitFor(
  percents: string[] | undefined,
  column: string
): string {
  return percents?.includes(column) ? "%" : "";
}

export function shortDate(value: unknown, withYear = false): string {
  const text = String(value ?? "");
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return text;

  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return text;

  return (withYear ? DAY_IN_YEAR : DAY).format(date);
}

export function categoryTick(value: unknown, withYear = false): string {
  const text = String(value ?? "");
  const asDate = shortDate(text, withYear);
  if (asDate !== text) return asDate;

  return text.length > TICK_CHARS ? `${text.slice(0, TICK_CHARS - 1)}…` : text;
}

export function spansYears(values: unknown[]): boolean {
  const years = new Set(
    values
      .map((value) => /^(\d{4})-/.exec(String(value ?? ""))?.[1])
      .filter(Boolean)
  );

  return years.size > 1;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function blank(value: unknown): string {
  return value === null || value === undefined ? "—" : String(value);
}
