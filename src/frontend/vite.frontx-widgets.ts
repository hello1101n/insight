import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";

// Spike: serves the FrontX widget bundles under /widgets/ for ?frontx=1.
const ENV = "FRONTX_WIDGETS_DIR";
const UNSET = `${ENV} is not set. Build the FrontX widget bundles and set ${ENV} to their dist folder (docs/frontx-dashboards-spike.md).`;
const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
};

export function frontxWidgets(): Plugin {
  const configured = process.env[ENV];
  const bundles = configured ? path.resolve(configured) : undefined;

  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/widgets/")) return next();
    if (!bundles) {
      res.statusCode = 503;
      res.setHeader("content-type", "text/plain");
      res.end(UNSET);
      return;
    }

    const file = path.join(
      bundles,
      decodeURIComponent(url.pathname.slice("/widgets/".length))
    );
    if (
      !file.startsWith(bundles + path.sep) ||
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
    config: () => ({
      define: {
        "import.meta.env.VITE_FRONTX_WIDGETS_SET": JSON.stringify(
          Boolean(bundles)
        ),
      },
    }),
    configureServer: (server) => {
      if (!bundles) server.config.logger.warn(UNSET);
      else if (!existsSync(path.join(bundles, "widgets.json"))) {
        server.config.logger.warn(`${ENV} has no widgets.json: ${bundles}`);
      }
      server.middlewares.use(serve);
    },
    configurePreviewServer: (server) => void server.middlewares.use(serve),
  };
}
