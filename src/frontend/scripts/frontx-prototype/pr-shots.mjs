// Prototype: paired screenshots, current against FrontX, of every example board.
// Files are <board>-<theme>[-<view>]-current.png and the same with -frontx.png.
// Usage: node pr-shots.mjs <origin> <out-dir>
import fs from "node:fs";
import path from "node:path";

import { args, boardUrl, cardOf, chromium } from "./common.mjs";

const [origin, out] = args(["origin", "out-dir"]);
fs.mkdirSync(out, { recursive: true });

const LIGHT = [
  "delivery-pulse",
  "delivery-overview",
  "kpi-overview",
  "breakdowns",
  "trends",
  "pipeline-runs",
  "edge-cases",
  "reading-notes",
];
const DARK = ["delivery-pulse", "breakdowns"];
const RENDERERS = [
  ["current", false],
  ["frontx", true],
];
const WIDTH = 1440;
// Long enough for the chart entry animations and a retried run to end.
const SETTLE_MS = 3000;

const browser = await chromium.launch();

async function open(board, frontx, scheme) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 1000 }, colorScheme: scheme });
  const page = await context.newPage();
  await page.goto(boardUrl(origin, board, frontx));
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(SETTLE_MS);
  return { context, page };
}

/** Grows the window to the board's height, since the page scrolls inside the `@container` element of `main`. */
async function fullBoard(page) {
  const height = await page.evaluate(() => {
    const scroller = document.querySelector('main [class~="@container"]') ?? document.body;
    return scroller.scrollHeight + scroller.getBoundingClientRect().top;
  });
  await page.setViewportSize({ width: WIDTH, height: Math.max(1000, Math.ceil(height)) });
  await page.waitForTimeout(1000);
}

const shot = (name, tag) => path.join(out, `${name}-${tag}.png`);

for (const [tag, frontx] of RENDERERS) {
  for (const [scheme, boards] of [
    ["light", LIGHT],
    ["dark", DARK],
  ]) {
    for (const board of boards) {
      const { context, page } = await open(board, frontx, scheme);
      await fullBoard(page);
      await page.screenshot({ path: shot(`${board}-${scheme}`, tag) });
      await context.close();
    }
  }

  // Close-ups and interactions on the board with one widget of each kind.
  const { context, page } = await open("delivery-pulse", frontx, "light");
  await fullBoard(page);
  await cardOf(page, "Deploys by team and outcome", frontx).screenshot({ path: shot("delivery-pulse-light-stacked-bar", tag) });
  await cardOf(page, "Change failure rate", frontx).screenshot({ path: shot("delivery-pulse-light-percent", tag) });

  await page.getByRole("button", { name: "Last 7 days" }).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(SETTLE_MS);
  await fullBoard(page);
  await page.screenshot({ path: shot("delivery-pulse-light-range-7-days", tag) });

  await page.setViewportSize({ width: WIDTH, height: 1200 });
  const expand = frontx ? "Open Deploys per day larger" : "Expand Deploys per day";
  await page.getByRole("button", { name: expand }).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(SETTLE_MS);
  await page.screenshot({ path: shot("delivery-pulse-light-larger-view", tag) });
  await context.close();
}

await browser.close();
console.log(fs.readdirSync(out).filter((f) => f.endsWith(".png")).sort().join("\n"));
