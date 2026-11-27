import { authStore } from "@/auth/auth-store";
import { loadSession } from "@/auth/session";
import { signIn } from "@/auth/use-auth";

let sessionProbe: Promise<void> | null = null;
let confirmedAt = 0;
const CONFIRMED_FOR_MS = 5_000;

export function resetSessionProbe(): void {
  sessionProbe = null;
  confirmedAt = 0;
}

function bounceToLogin(): void {
  try {
    signIn();
  } catch {
    // WORKAROUND: navigation throws in a sandboxed frame; the caller still gets its 401 response.
  }
}

async function bounceIfSessionEnded(): Promise<void> {
  if (authStore.getSnapshot().status === "unauthenticated") {
    bounceToLogin();
    return;
  }
  if (Date.now() - confirmedAt < CONFIRMED_FOR_MS) return;

  const mine = (sessionProbe ??= loadSession()
    .then((status) => {
      if (status === "unauthenticated") bounceToLogin();
      else confirmedAt = Date.now();
    })
    .finally(() => {
      if (sessionProbe === mine) sessionProbe = null;
    }));

  await mine;
}

export async function fetchWithAuth(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: "include" });

  if (res.status === 401) await bounceIfSessionEnded();
  return res;
}
