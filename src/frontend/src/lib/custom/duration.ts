import type { DurationUnit } from "@/api/custom-client";

const UNIT_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const UNIT_LABEL: Record<DurationUnit, string> = {
  ms: "ms",
  s: "s",
  min: "m",
  h: "h",
  d: "d",
};

// INVARIANT: a part shows at the precision of the part after it, so a duration has at most two parts.
const PARTS: readonly [label: string, size: number, step: number][] = [
  ["d", UNIT_MS.d, UNIT_MS.h],
  ["h", UNIT_MS.h, UNIT_MS.min],
  ["m", UNIT_MS.min, UNIT_MS.s],
  ["s", UNIT_MS.s, UNIT_MS.s],
];

const NEXT_LABEL: Record<string, string> = { d: "h", h: "m", m: "s" };

export function durationText(value: number, unit: DurationUnit): string {
  const sign = value < 0 ? "-" : "";
  const ms = Math.abs(value) * UNIT_MS[unit];
  if (Math.round(ms) === 0) return `0${UNIT_LABEL[unit]}`;

  for (const [label, size, step] of PARTS) {
    const rounded = Math.round(ms / step) * step;
    if (rounded < size) continue;

    const whole = Math.floor(rounded / size);
    const rest = Math.round((rounded - whole * size) / step);
    const next = NEXT_LABEL[label];
    return rest > 0 && next
      ? `${sign}${whole}${label} ${rest}${next}`
      : `${sign}${whole}${label}`;
  }

  return `${sign}${Math.round(ms)}ms`;
}
