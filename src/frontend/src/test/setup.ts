import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

import {
  installIntersectionObserver,
  scrollEndOutOfView,
} from "./intersection-observer";

installIntersectionObserver();
afterEach(scrollEndOutOfView);

// WORKAROUND: jsdom in vitest's worker pool can leave `window.localStorage` undefined at import time.
if (typeof window !== "undefined" && !window.localStorage) {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k) => store.get(k) ?? null,
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => {
      store.delete(k);
    },
    setItem: (k, v) => {
      store.set(k, String(v));
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: shim,
    configurable: true,
  });
}

await import("@/i18n");

afterEach(() => {
  cleanup();
});
