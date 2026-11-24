import { useSyncExternalStore } from "react";

import { authStore } from "./auth-store";
import type { AuthSnapshot } from "./types";

let redirecting = false;

// WORKAROUND: a bfcache restore revives this module with `redirecting` still true.
if (typeof window !== "undefined") {
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) redirecting = false;
  });
}

function safeReturnTo(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path.startsWith("/auth/") || path === "/auth" ? "/" : path;
}

export function signIn(returnTo?: string): void {
  if (redirecting) return;
  redirecting = true;
  const dest = safeReturnTo(
    returnTo ??
      window.location.pathname + window.location.search + window.location.hash
  );
  window.location.assign(`/auth/login?return_to=${encodeURIComponent(dest)}`);
}

export async function signOut(): Promise<void> {
  let dest = "/";
  try {
    const csrfToken = authStore.getSnapshot().session?.csrfToken ?? "";
    const res = await fetch("/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
    });
    const body = (await res.json().catch(() => ({}))) as {
      rp_logout_url?: string | null;
    };
    if (body.rp_logout_url) dest = body.rp_logout_url;
  } catch {
    // ignore — best-effort logout; still bounce the browser.
  }
  authStore.setUnauthenticated();
  window.location.assign(dest);
}

export type UseAuthResult = AuthSnapshot & {
  signIn: (returnTo?: string) => void;
  signOut: () => Promise<void>;
};

export function useAuth(): UseAuthResult {
  const snap = useSyncExternalStore(
    authStore.subscribe,
    authStore.getSnapshot,
    authStore.getSnapshot
  );
  return { ...snap, signIn, signOut };
}
