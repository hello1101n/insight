import type { Mock } from "vitest";

type Shown = { type?: string; title?: unknown; description?: unknown; timeout?: number };

export function toastsOf(add: Mock, type: "success" | "error"): Shown[] {
  return add.mock.calls
    .map(([toast]) => toast as Shown)
    .filter((toast) => toast.type === type);
}
