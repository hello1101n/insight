import type { MetricFormat } from "@/api/metric-results-client";
import { displayStepsPerUnit } from "@/lib/format";

export function percentShareLabels(values: number[]): string[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return values.map(() => "0");

  const integers = largestRemainder(values, total, 100);
  const needsTenths = values.some(
    (value, index) => value > 0 && integers[index] === 0,
  );
  if (!needsTenths) return integers.map(String);

  const tenths = largestRemainder(values, total, 1000);
  for (let index = 0; index < values.length; index += 1) {
    if (!((values[index] ?? 0) > 0) || tenths[index] !== 0) continue;
    const largest = tenths.indexOf(Math.max(...tenths));
    if (largest === -1 || (tenths[largest] ?? 0) <= 1) break;
    tenths[largest] = (tenths[largest] ?? 0) - 1;
    tenths[index] = 1;
  }
  return tenths.map((share) =>
    share % 10 === 0 ? String(share / 10) : (share / 10).toFixed(1),
  );
}

export function displayedParts(
  parts: number[],
  total: number,
  fmt: MetricFormat,
  unit?: string | null,
): number[] {
  const partsSum = parts.reduce((sum, value) => sum + value, 0);
  const additive = Math.abs(partsSum - total) <= 1e-6 * Math.max(1, Math.abs(total));
  if (!additive || !(partsSum > 0)) return parts;

  const scale = displayStepsPerUnit(fmt, unit);
  const units = Math.round(total * scale);
  return largestRemainder(parts, partsSum, units).map((value) => value / scale);
}

function largestRemainder(
  values: number[],
  total: number,
  units: number,
): number[] {
  const exact = values.map((value) => (value / total) * units);
  const shares = exact.map((value) => Math.floor(value));
  let remainder = units - shares.reduce((sum, value) => sum + value, 0);

  const byFraction = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < byFraction.length && remainder > 0; i += 1) {
    shares[byFraction[i]!.index] += 1;
    remainder -= 1;
  }
  return shares;
}
