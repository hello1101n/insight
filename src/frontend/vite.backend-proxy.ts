import type { ClientRequest, IncomingMessage } from "node:http";
import type { Plugin, ProxyOptions } from "vite";

// WORKAROUND: with no upstream, vite's SPA fallback serves /auth/login and the login loops.
const DEFAULT_TARGET = "http://localhost:8080";

const SESSION_COOKIE = "__Host-sid";
const SESSION_PAIR = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`);
const PROXIED_PREFIXES = ["/api", "/auth"];

// WORKAROUND: a stand's OIDC redirect_uri is its own origin, and a browser on plain http
// cannot store its `Secure` `__Host-sid` cookie, so the dev server holds the session.
type DevSession = {
  readonly seededAtStart: boolean;
  cookieHeader(incoming: string | number | string[] | undefined): string;
  absorbSetCookie(setCookie: string[] | undefined): string[] | undefined;
};

function splitCookie(incoming: string | number | string[] | undefined): string[] {
  const raw = Array.isArray(incoming) ? incoming.join("; ") : String(incoming ?? "");
  return raw
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean);
}

function createDevSession(seed: string): DevSession {
  let token = seed;

  return {
    seededAtStart: seed !== "",

    cookieHeader(incoming) {
      const pairs = splitCookie(incoming).filter(
        (pair) => !pair.startsWith(`${SESSION_COOKIE}=`)
      );
      if (token) pairs.push(`${SESSION_COOKIE}=${token}`);
      return pairs.join("; ");
    },

    absorbSetCookie(setCookie) {
      if (!setCookie) return undefined;
      const kept: string[] = [];
      for (const directive of setCookie) {
        if (!directive.startsWith(`${SESSION_COOKIE}=`)) {
          kept.push(directive);
          continue;
        }
        token = directive.slice(SESSION_COOKIE.length + 1).split(";")[0] ?? "";
      }
      return kept.length > 0 ? kept : undefined;
    },
  };
}

export function normalizeSessionToken(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  if (!trimmed) return "";
  return (SESSION_PAIR.exec(trimmed)?.[1] ?? trimmed.split(";")[0] ?? "").trim();
}

function proxyEntry(
  target: string,
  session: DevSession,
  secure: boolean
): ProxyOptions {
  const targetOrigin = new URL(target).origin;

  return {
    target,
    changeOrigin: true,
    secure,
    configure(proxy) {
      if (!session.seededAtStart) return;

      proxy.on("proxyReq", (proxyReq: ClientRequest) => {
        const cookie = session.cookieHeader(proxyReq.getHeader("cookie"));
        if (cookie) proxyReq.setHeader("cookie", cookie);
        else proxyReq.removeHeader("cookie");
      });

      proxy.on("proxyRes", (proxyRes: IncomingMessage) => {
        const kept = session.absorbSetCookie(proxyRes.headers["set-cookie"]);
        if (kept) proxyRes.headers["set-cookie"] = kept;
        else delete proxyRes.headers["set-cookie"];

        // WORKAROUND: under changeOrigin the stand emits absolute Locations on its public host.
        const location = proxyRes.headers.location;
        if (typeof location === "string" && location.startsWith(targetOrigin)) {
          proxyRes.headers.location = location.slice(targetOrigin.length) || "/";
        }
      });
    },
  };
}

function loginGuidance(target: string): string {
  return [
    "Insight dev proxy blocked /auth/login.",
    "",
    `${target} registers its OIDC redirect_uri on its own origin, so a login`,
    "started here finishes there and this dev server never gets a session.",
    "",
    `The SPA asked to log in because ${target} rejected`,
    "VITE_API_PROXY_SESSION — expired, revoked, or mistyped.",
    "",
    `Sign in to ${target} in a browser, copy the ${SESSION_COOKIE} value from`,
    "DevTools > Application > Cookies, set VITE_API_PROXY_SESSION in",
    "src/frontend/.env.local, and restart `pnpm dev`.",
  ].join("\n");
}

export function backendProxy(env: Record<string, string>): Plugin {
  const target = env.VITE_API_PROXY_TARGET || DEFAULT_TARGET;
  const secure = env.VITE_API_PROXY_INSECURE !== "true";
  const session = createDevSession(
    normalizeSessionToken(env.VITE_API_PROXY_SESSION ?? "")
  );

  return {
    name: "insight:backend-proxy",
    apply: "serve",

    config: () => ({
      server: {
        proxy: Object.fromEntries(
          PROXIED_PREFIXES.map((prefix) => [
            prefix,
            proxyEntry(target, session, secure),
          ])
        ),
      },
    }),

    configureServer(server) {
      if (!session.seededAtStart) return;

      server.config.logger.warn(
        `[backend-proxy] attaching a ${SESSION_COOKIE} session to every ` +
          `${PROXIED_PREFIXES.join(" and ")} request to ${target}. That is a ` +
          "live session on that stand — keep VITE_API_PROXY_SESSION out of git."
      );

      // WORKAROUND: middleware added in the hook body runs ahead of vite's proxy.
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/auth/login")) {
          next();
          return;
        }
        res.statusCode = 503;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(loginGuidance(target));
      });
    },
  };
}
