const ATTEMPTS_KEY = "insight.auth-error-attempts";
const MAX_AUTO_RETRIES = 1;

export type AuthError = {
  code: string;
  autoRetry: boolean;
};

export function consumeAuthErrorParam(): AuthError | null {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("auth_error")) return null;
  const code = url.searchParams.get("auth_error") ?? "";
  url.searchParams.delete("auth_error");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  if (!code) return null;
  const previous = readAttempts();
  if (previous === null) return { code, autoRetry: false };
  const attempts = previous + 1;
  const counted = writeAttempts(attempts);
  return {
    code,
    autoRetry:
      counted && code !== "access_denied" && attempts <= MAX_AUTO_RETRIES,
  };
}

export function clearAuthErrorAttempts(): void {
  try {
    sessionStorage.removeItem(ATTEMPTS_KEY);
  } catch {
    // WORKAROUND: sessionStorage throws when storage is blocked; nothing to clear.
  }
}

function readAttempts(): number | null {
  try {
    const parsed = Number(sessionStorage.getItem(ATTEMPTS_KEY) ?? "0");
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return null;
  }
}

function writeAttempts(attempts: number): boolean {
  try {
    sessionStorage.setItem(ATTEMPTS_KEY, String(attempts));
    return true;
  } catch {
    return false;
  }
}
