const PICK_STORAGE_KEY = "insight.metricsView.metrics";

export function readStoredMetricsPick(): string | null {
  try {
    return window.localStorage.getItem(PICK_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeMetricsPick(value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(PICK_STORAGE_KEY);
    else window.localStorage.setItem(PICK_STORAGE_KEY, value);
  } catch {
    return;
  }
}
