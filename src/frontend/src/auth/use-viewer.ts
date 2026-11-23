import { useSyncExternalStore } from "react";

import { authStore } from "./auth-store";

export type Viewer = {
  email: string | null;
  personId: string | null;
};

function resolve(): Viewer {
  const { session } = authStore.getSnapshot();
  return {
    email: session?.email ?? null,
    personId: session?.personId ?? null,
  };
}

export function useViewer(): Viewer {
  useSyncExternalStore(
    authStore.subscribe,
    authStore.getSnapshot,
    authStore.getSnapshot,
  );
  return resolve();
}


export function getViewerPersonId(): string | null {
  return resolve().personId;
}
