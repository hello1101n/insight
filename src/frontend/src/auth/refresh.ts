import { authStore } from "./auth-store";
import { loadSession, unixSeconds } from "./session";
import { signIn } from "./use-auth";

const LEASE_KEY = "insight.auth.refresh.leader";
const FALLBACK_MSG_KEY = "insight.auth.refresh.msg";
const CHANNEL_NAME = "insight.auth.refresh";

const LEASE_TTL_MS = 15_000;
const HEARTBEAT_MS = 5_000;
const RETRY_MS = 15_000;
const RATE_LIMIT_RETRY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;

type RefreshMessage =
  | { kind: "refreshed"; expiresAt: number; refreshAt: number }
  | { kind: "expired" };

type RefreshedMessage = Extract<RefreshMessage, { kind: "refreshed" }>;

type Lease = { id: string; ts: number };

function readLease(): Lease | null {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Lease>;
    if (typeof parsed.id !== "string" || typeof parsed.ts !== "number") return null;
    return { id: parsed.id, ts: parsed.ts };
  } catch {
    return null;
  }
}

class RefreshDriver {
  private readonly tabId = crypto.randomUUID();
  private channel: BroadcastChannel | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private stopped = false;
  private readonly cleanups: Array<() => void> = [];

  start(): void {
    if (typeof BroadcastChannel !== "undefined") {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = (e: MessageEvent) => {
        this.onMessage(e.data);
      };
    }
    this.listen(window, "storage", (e) => {
      const ev = e as StorageEvent;
      if (ev.key !== FALLBACK_MSG_KEY || !ev.newValue) return;
      try {
        this.onMessage(JSON.parse(ev.newValue));
      } catch {
        // ignore corrupt cross-tab payloads
      }
    });
    // WORKAROUND: timers do not fire while the machine sleeps or the tab is frozen.
    this.listen(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") this.tick();
    });
    this.listen(window, "pagehide", () => {
      this.releaseLease();
    });
    this.cleanups.push(
      authStore.subscribe(() => {
        if (authStore.getSnapshot().status === "unauthenticated") this.stop();
      }),
    );

    this.heartbeat = setInterval(() => {
      this.tick();
    }, HEARTBEAT_MS);
    this.tick();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.clearTimer();
    this.releaseLease();
    this.channel?.close();
    this.channel = null;
    for (const undo of this.cleanups.splice(0)) undo();
  }

  private tick(): void {
    if (this.stopped || this.refreshing) return;
    if (!this.tryLead()) {
      this.clearTimer();
      return;
    }
    const session = authStore.getSnapshot().session;
    if (!session || session.refreshAt == null) return;
    if (this.timer !== null) return;
    const delayMs = Math.max(0, session.refreshAt * 1000 - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delayMs);
  }

  private tryLead(): boolean {
    const lease = readLease();
    if (lease && lease.id !== this.tabId && Date.now() - lease.ts <= LEASE_TTL_MS) {
      return false;
    }
    try {
      localStorage.setItem(LEASE_KEY, JSON.stringify({ id: this.tabId, ts: Date.now() }));
    } catch {
      // WORKAROUND: localStorage throws when storage is blocked; lead without a lease.
    }
    return true;
  }

  private releaseLease(): void {
    try {
      if (readLease()?.id === this.tabId) localStorage.removeItem(LEASE_KEY);
    } catch {
      // WORKAROUND: localStorage throws when storage is blocked; the lease ages out.
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async refresh(): Promise<void> {
    if (this.stopped || this.refreshing) return;
    this.refreshing = true;
    try {
      const csrfToken = authStore.getSnapshot().session?.csrfToken ?? "";
      const res = await fetch("/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (this.stopped) return;

      if (res.status === 401) {
        publishExpiry();
        this.expire();
        return;
      }
      if (res.status === 429) {
        this.retryIn(retryAfterMs(res) ?? RATE_LIMIT_RETRY_MS);
        return;
      }
      if (res.status === 403) {
        if ((await loadSession()) !== "authenticated") {
          publishExpiry();
          this.expire();
          return;
        }
        const refreshAt = authStore.getSnapshot().session?.refreshAt;
        if (refreshAt == null) {
          this.refreshing = false;
          return;
        }
        this.retryIn(retryDelayAfterReprime(refreshAt, Date.now()));
        return;
      }
      if (!res.ok) {
        this.retryIn(RETRY_MS);
        return;
      }

      const body = (await res.json()) as { expires_at?: number; refresh_at?: number };
      if (typeof body.expires_at !== "number" || typeof body.refresh_at !== "number") {
        this.retryIn(RETRY_MS);
        return;
      }
      this.apply(body.expires_at, body.refresh_at);
      this.broadcast({ kind: "refreshed", expiresAt: body.expires_at, refreshAt: body.refresh_at });
      this.refreshing = false;
      this.tick();
    } catch {
      this.retryIn(RETRY_MS);
    }
  }

  private retryIn(delayMs: number): void {
    this.refreshing = false;
    if (this.stopped) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delayMs);
  }

  private apply(expiresAt: number, refreshAt: number): void {
    const session = authStore.getSnapshot().session;
    if (session) {
      authStore.setAuthenticated({
        ...session,
        expiresAt: unixSeconds(expiresAt),
        refreshAt: unixSeconds(refreshAt),
      });
    }
  }

  private expire(): void {
    this.stop();
    authStore.setUnauthenticated();
    signIn();
  }

  private onMessage(raw: unknown): void {
    if (this.stopped || typeof raw !== "object" || raw === null) return;
    const msg = raw as Partial<RefreshMessage>;
    if (
      msg.kind === "refreshed" &&
      typeof msg.expiresAt === "number" &&
      typeof msg.refreshAt === "number"
    ) {
      this.apply(msg.expiresAt, msg.refreshAt);
      this.clearTimer();
      this.tick();
      return;
    }
    if (msg.kind === "expired") this.expire();
  }

  private broadcast(msg: RefreshedMessage): void {
    if (this.channel) {
      this.channel.postMessage(msg);
      return;
    }
    writeStorageMessage(msg);
  }

  private listen(
    target: Window | Document,
    type: string,
    handler: (e: Event) => void,
  ): void {
    target.addEventListener(type, handler);
    this.cleanups.push(() => {
      target.removeEventListener(type, handler);
    });
  }
}

function writeStorageMessage(msg: RefreshMessage): void {
  try {
    // WORKAROUND: storage events fire only in other tabs and only on a changed value.
    localStorage.setItem(
      FALLBACK_MSG_KEY,
      JSON.stringify({ ...msg, nonce: crypto.randomUUID() }),
    );
  } catch {
    // WORKAROUND: localStorage throws when storage is blocked; followers still hit 401.
  }
}

function publishExpiry(): void {
  writeStorageMessage({ kind: "expired" });
}

function retryDelayAfterReprime(refreshAt: number, now: number): number {
  return Math.max(RETRY_MS, refreshAt * 1000 - now);
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers?.get?.("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

export function startSessionRefresh(): () => void {
  const driver = new RefreshDriver();
  driver.start();
  return () => {
    driver.stop();
  };
}
