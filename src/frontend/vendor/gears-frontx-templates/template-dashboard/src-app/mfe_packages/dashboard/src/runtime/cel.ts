import { Environment } from '@marcbachmann/cel-js';

/*
 * The binding runner's internal interface to the CEL library (DESIGN §3.3):
 * parse, check, evaluate, convert to JSON. The rest of the root never imports
 * the library, so it can be swapped in this one module.
 */

const env = new Environment({ unlistedVariablesAreDyn: true, homogeneousAggregateLiterals: false });

export interface Transform {
  /** Evaluates on the given variables only; an undeclared identifier fails with an unknown-variable error. */
  evaluate(variables: Record<string, unknown>): unknown;
}

/** Parses and checks a transform; throws before anything runs when it does not parse or check. */
export function compileTransform(expression: string): Transform {
  const checked = env.check(expression) as { valid: boolean; error?: unknown };
  if (!checked.valid) throw checked.error instanceof Error ? checked.error : new Error(`transform does not check: ${String(checked.error)}`);
  const program = env.parse(expression);
  return { evaluate: (variables) => toJson(program(variables)) };
}

/*
 * The library's value classes are not exported; the values it makes give them, so the checks below survive a bundler
 * that renames classes.
 */
const UnsignedInt = (env.evaluate('0u') as object).constructor;
const Duration = (env.evaluate("duration('0s')") as object).constructor;

/** A CEL integer (int or uint) as a JSON number; one a number cannot hold exactly fails, never rounds. */
function integerToJson(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`the integer ${value} is outside the range a JSON number holds exactly (±${Number.MAX_SAFE_INTEGER})`);
  }
  return Number(value);
}

/**
 * A CEL duration as its seconds text: the seconds with the fraction, trailing zeros stripped, then `s` (`90s`, `1.5s`).
 * Read from the total nanoseconds: a difference of durations may carry seconds and nanos of opposite signs.
 */
function durationToJson(value: { seconds: bigint; nanos: number }): string {
  const total = value.seconds * 1_000_000_000n + BigInt(value.nanos);
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const seconds = abs / 1_000_000_000n;
  const nanos = Number(abs % 1_000_000_000n);
  const fraction = nanos ? `.${String(nanos).padStart(9, '0').replace(/0+$/, '')}` : '';
  return `${negative ? '-' : ''}${seconds}${fraction}s`;
}

/**
 * CEL values as JSON, the CEL JSON mapping: int and uint come back as bigint and an `UnsignedInt` and become numbers,
 * a map may come back as Map, a timestamp (a Date) becomes its RFC 3339 text, a duration its seconds text, bytes
 * their base64 text. A value with no JSON form (a CEL type such as `int`) fails the transform.
 */
export function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return integerToJson(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof UnsignedInt) return integerToJson((value as { value: bigint }).value);
  if (value instanceof Duration) return durationToJson(value as unknown as { seconds: bigint; nanos: number });
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(''));
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [String(key), toJson(item)]));
  if (Array.isArray(value)) return value.map(toJson);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('the result holds a CEL value with no JSON form, such as a type');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]));
}
