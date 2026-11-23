export const INTERVAL_PRESETS_SECS: readonly number[] = [
  60, 300, 900, 3_600, 21_600, 86_400, 604_800,
];

const UNITS: readonly { secs: number; one: string; many: string }[] = [
  { secs: 86_400, one: "day", many: "days" },
  { secs: 3_600, one: "hour", many: "hours" },
  { secs: 60, one: "minute", many: "minutes" },
  { secs: 1, one: "second", many: "seconds" },
];

function parts(secs: number): { amount: number; one: string; many: string } {
  const unit = UNITS.find((one) => secs % one.secs === 0) ?? UNITS[3];

  return { amount: secs / unit.secs, one: unit.one, many: unit.many };
}

export function intervalLabel(secs: number): string {
  const { amount, one, many } = parts(secs);

  return `${amount} ${amount === 1 ? one : many}`;
}
