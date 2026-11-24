export const MODES = ["queue", "person", "accounts"] as const;

export const DEFAULT_MODE = MODES[0];

export function resolveMode(mode: string | undefined): string {
  if (mode === undefined) return DEFAULT_MODE;
  return MODES.find((m) => m === mode) ?? DEFAULT_MODE;
}

export const MODE_LABELS: Readonly<Record<string, string>> = {
  queue: "Review queue",
  person: "A person and their accounts",
  accounts: "An account and whose it is",
};
