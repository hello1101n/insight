import { authStore } from "./auth-store";
import type { AuthStatus } from "./types";

export function unixSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

const REQUEST_TIMEOUT_MS = 10_000;

export async function loadSession(): Promise<AuthStatus> {
  try {
    const res = await fetch("/auth/me", {
      credentials: "include",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      authStore.setUnauthenticated();
      return "unauthenticated";
    }
    const body = (await res.json()) as {
      user?: string;
      email?: string;
      tenant_id?: string;
      roles?: string[];
      csrf_token?: string;
      expires_at?: number;
      refresh_at?: number;
      experiments_enabled?: boolean;
      impersonator_email?: string;
    };
    if (!body.csrf_token) {
      console.warn(
        "/auth/me returned no csrf_token; treating as unauthenticated"
      );
      authStore.setUnauthenticated();
      return "unauthenticated";
    }
    authStore.setAuthenticated({
      personId: body.user ?? "",
      email: body.email ?? "",
      tenantId: body.tenant_id ?? "",
      roles: body.roles ?? [],
      csrfToken: body.csrf_token,
      expiresAt: unixSeconds(body.expires_at),
      refreshAt: unixSeconds(body.refresh_at),
      experimentsEnabled: body.experiments_enabled === true,
      impersonatorEmail: body.impersonator_email || null,
    });
    return "authenticated";
  } catch {
    authStore.setUnauthenticated();
    return "unauthenticated";
  }
}
