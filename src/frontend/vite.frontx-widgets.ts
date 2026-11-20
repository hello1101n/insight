import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";

// Spike: serves the FrontX widget bundles built in the template clone under /widgets/.
const BUNDLES = path.resolve(
  process.env.FRONTX_WIDGETS_DIR ??
    path.join(
      __dirname,
      "../../../repos/gears-frontx-templates/template-dashboard/src-app/mfe_packages/widgets/dist"
    )
);
const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".map": "application/json",
};

export function frontxWidgets(): Plugin {
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/widgets/")) return next();
    const file = path.join(
      BUNDLES,
      decodeURIComponent(url.pathname.slice("/widgets/".length))
    );
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
    // Hashed chunks cache for long; lists, parts and shared modules revalidate.
    res.setHeader(
      "cache-control",
      url.pathname.includes("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache"
    );
    createReadStream(file).pipe(res);
  };
  return {
    name: "frontx-widgets",
    configureServer: (server) => void server.middlewares.use(serve),
    configurePreviewServer: (server) => void server.middlewares.use(serve),
  };
}
