import { useSyncExternalStore } from "react";

export interface OrgScope {
  root: string | null;
  directOnly: boolean;
  attrFilter?: { key: string; value: string };
}

const RETIRED_ENABLED_KEY = "insight.portal";
const SHOW_PLANNED_KEY = "insight.portal.showPlanned";
const RAIL_LABELS_KEY = "insight.portal.railLabels";

interface PortalState {
  showPlanned: boolean;
  railLabels: boolean;
}

// WORKAROUND: storage access throws SecurityError in a sandboxed iframe or with blocked storage,
// and these readers run at module scope.
function readKey(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readOptInPref(key: string): boolean {
  return readKey(key) === "true";
}

function forgetRetiredPreference(): void {
  if (typeof window === "undefined") return;
  if (readKey(RETIRED_ENABLED_KEY) === null) return;
  try {
    window.localStorage.removeItem(RETIRED_ENABLED_KEY);
  } catch {
    // localStorage unavailable — nothing reads the key either way.
  }
}

forgetRetiredPreference();

let state: PortalState = {
  showPlanned: readOptInPref(SHOW_PLANNED_KEY),
  railLabels: readOptInPref(RAIL_LABELS_KEY),
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function persist(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable — in-memory state still updated.
  }
}

export function setPortalShowPlanned(show: boolean): void {
  state = { ...state, showPlanned: show };
  persist(SHOW_PLANNED_KEY, show ? "true" : "false");
  emit();
}

export function getPortalShowPlanned(): boolean {
  return state.showPlanned;
}

export function usePortalShowPlanned(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => state.showPlanned,
    () => false,
  );
}

export function setPortalRailLabels(show: boolean): void {
  state = { ...state, railLabels: show };
  persist(RAIL_LABELS_KEY, show ? "true" : "false");
  emit();
}

export function usePortalRailLabels(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => state.railLabels,
    () => false,
  );
}
