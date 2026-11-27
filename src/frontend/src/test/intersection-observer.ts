type Callback = (entries: Array<{ isIntersecting: boolean }>) => void;

const watching = new Set<Callback>();
let endInView = false;

export function scrollEndIntoView(): void {
  endInView = true;
  for (const callback of [...watching]) {
    callback([{ isIntersecting: true }]);
  }
}

export function scrollEndOutOfView(): void {
  endInView = false;
  for (const callback of [...watching]) {
    callback([{ isIntersecting: false }]);
  }
}

export function installIntersectionObserver(): void {
  class Stub implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly scrollMargin = "";
    readonly thresholds: ReadonlyArray<number> = [];
    #callback: Callback;

    constructor(callback: Callback) {
      this.#callback = callback;
    }
    observe(): void {
      watching.add(this.#callback);
      // INVARIANT: like the platform, observe() reports the target's current state.
      if (endInView) this.#callback([{ isIntersecting: true }]);
    }
    unobserve(): void {
      watching.delete(this.#callback);
    }
    disconnect(): void {
      watching.delete(this.#callback);
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  globalThis.IntersectionObserver = Stub as unknown as typeof IntersectionObserver;
}
