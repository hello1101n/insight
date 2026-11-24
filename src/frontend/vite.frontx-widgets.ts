import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";

// INVARIANT: `pnpm build:widgets` writes the FrontX widget bundles here.
const BUNDLES = path.resolve(import.meta.dirname, "node_modules/.frontx-widgets");
const PREFIX = "/widgets/";
const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
};

const serve: Connect.NextHandleFunction = (req, res, next) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(PREFIX)) return next();

  const file = path.join(
    BUNDLES,
    decodeURIComponent(url.pathname.slice(PREFIX.length))
  );
  // SAFETY: a `..` segment must not reach a file outside the bundle folder.
  if (
    !file.startsWith(BUNDLES + path.sep) ||
    !existsSync(file) ||
    !statSync(file).isFile()
  ) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  res.setHeader(
    "content-type",
    TYPES[path.extname(file)] ?? "application/octet-stream"
  );
  res.setHeader(
    "cache-control",
    url.pathname.includes("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache"
  );
  createReadStream(file).pipe(res);
};

export function frontxWidgets(): Plugin {
  return {
    name: "frontx-widgets",
    apply: "serve",
    configureServer: (server) => {
      if (!existsSync(path.join(BUNDLES, "widgets.json"))) {
        server.config.logger.warn(
          "The FrontX widget bundles are not built. Run `pnpm build:widgets` to draw dashboards through FrontX."
        );
      }
      server.middlewares.use(serve);
    },
  };
}
