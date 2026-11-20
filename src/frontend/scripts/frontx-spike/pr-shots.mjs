// Spike: paired screenshots, current against FrontX, for the pull request.
// Every file name ends in -current.png or -frontx.png.
// Usage: node pr-shots.mjs <origin> <out-dir>
import fs from "node:fs";
import path from "node:path";

import { args, BOARDS, boardUrl, cardOf, chromium, drawnProbe, waitDrawn } from "./common.mjs";

const [origin, out] = args(["origin", "out-dir"]);
fs.mkdirSync(out, { recursive: true });

const RENDERERS = [
  ["current", false],
  ["frontx", true],
];
// Long enough for the chart entry animations to end.
const SETTLE_MS = 2500;

const browser = await chromium.launch();

async function open(board, frontx, { scheme = "light", height = 1700 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height }, colorScheme: scheme });
  const page = await context.newPage();
  await page.addInitScript(drawnProbe, { frontx, expect: BOARDS[board] });
  await page.goto(boardUrl(origin, board, frontx));
  await waitDrawn(page);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(SETTLE_MS);
  return { context, page };
}

const shot = (name, tag) => path.join(out, `${name}-${tag}.png`);

for (const [tag, frontx] of RENDERERS) {
  for (const scheme of ["light", "dark"]) {
    const { context, page } = await open("delivery-pulse", frontx, { scheme });
    await page.screenshot({ path: shot(`board-8-widgets-${scheme}`, tag) });
    await context.close();
  }

  {
    const { context, page } = await open("delivery-overview", frontx, { height: 700 });
    await page.screenshot({ path: shot("board-table-light", tag) });
    await context.close();
  }

  {
    const { context, page } = await open("delivery-pulse", frontx);
    await cardOf(page, "Deploys by team and outcome", frontx).screenshot({ path: shot("gap-stacked-bar", tag) });
    await cardOf(page, "Change failure rate", frontx).screenshot({ path: shot("gap-percent", tag) });

    await page.getByRole("button", { name: "Last 7 days" }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: shot("range-7-days-light", tag) });

    const expand = frontx ? "Open Deploys per day larger" : "Expand Deploys per day";
    await page.getByRole("button", { name: expand }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: shot("larger-view-light", tag), clip: { x: 0, y: 0, width: 1440, height: 1200 } });
    await context.close();
  }
}

await browser.close();
console.log(fs.readdirSync(out).filter((f) => f.endsWith(".png")).sort().join("\n"));
