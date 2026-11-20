// Spike: screenshots of current pages, to compare two ui-kit versions with pixdiff.mjs.
// Usage: node kitshots.mjs <origin> <out-dir>
import fs from "node:fs";
import path from "node:path";

import { args, chromium } from "./common.mjs";

const [origin, out] = args(["origin", "out-dir"]);
fs.mkdirSync(out, { recursive: true });

const PAGES = {
  home: "/",
  list: "/dashboards",
  board: "/dashboards/delivery-pulse",
  table: "/dashboards/delivery-overview",
};

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1600 }, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  for (const [name, route] of Object.entries(PAGES)) {
    await page.goto(origin + route);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(out, `${name}-${scheme}.png`) });
  }
  await context.close();
}
await browser.close();
