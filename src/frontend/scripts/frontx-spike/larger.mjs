// Spike: open the FrontX larger view and data view, count the run requests each
// sends, and list the ancestors that decide where the larger view paints.
// Usage: node larger.mjs <origin> <out-dir>
import fs from "node:fs";
import path from "node:path";

import { args, boardUrl, chromium } from "./common.mjs";

const [origin, out] = args(["origin", "out-dir"]);
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
let runs = 0;
page.on("requestfinished", (r) => /\/run$/.test(new URL(r.url()).pathname) && (runs += 1));

await page.goto(boardUrl(origin, "delivery-pulse", true));
await page.waitForLoadState("networkidle");
await page.waitForTimeout(2000);

runs = 0;
await page.getByRole("button", { name: "Open Deploys per day larger" }).click();
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, "larger-view.png") });
const placement = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return "no dialog";
  const chain = [];
  for (let el = dialog; el && el !== document.documentElement; el = el.parentElement) {
    const s = getComputedStyle(el);
    const marks = [
      s.containerType !== "normal" && `container-type:${s.containerType}`,
      s.isolation === "isolate" && "isolation:isolate",
      s.transform !== "none" && "transform",
      s.position === "fixed" && "position:fixed",
      s.zIndex !== "auto" && `z-index:${s.zIndex}`,
    ].filter(Boolean);
    if (marks.length) chain.push(`${el.tagName.toLowerCase()}: ${marks.join(" ")}`);
  }
  return { inBody: dialog.parentElement === document.body, chain };
});
console.log("larger view run requests:", runs);
console.log("larger view placement:", JSON.stringify(placement));

await page.keyboard.press("Escape");
await page.waitForTimeout(500);
runs = 0;
await page.getByRole("button", { name: "Show data" }).first().click();
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, "show-data.png") });
console.log("data view run requests:", runs);
console.log("console errors:", errors.length ? errors : "none");
await browser.close();
