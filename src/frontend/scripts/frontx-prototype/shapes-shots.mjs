// Prototype: each card of the chart-shapes board, current against FrontX.
// Usage: node shapes-shots.mjs <origin> <out-dir>
import fs from "node:fs";
import path from "node:path";

import { args, boardUrl, cardOf, chromium } from "./common.mjs";

const [origin, out] = args(["origin", "out-dir"]);
fs.mkdirSync(out, { recursive: true });

const TITLES = [
  ["builds-per-day", "Builds by result per day"],
  ["severity-by-repository", "Open issues by repository and severity"],
  ["failure-rate", "Failure rate per test"],
  ["cost-per-day", "Cost per day, USD"],
  ["signups-per-day", "Sign-ups per day"],
  ["top-authors", "Merged pull requests per author, top 10"],
  ["pass-rate", "Pass rate per day"],
  ["ticket-categories", "Support tickets by category"],
];

const browser = await chromium.launch();
for (const [tag, frontx] of [
  ["current", false],
  ["frontx", true],
]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 3000 },
  });
  const page = await context.newPage();
  await page.goto(boardUrl(origin, "chart-shapes", frontx));
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3500);
  for (const [name, title] of TITLES) {
    const card = cardOf(page, title, frontx);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: path.join(out, `${name}-${tag}.png`) });
  }
  await context.close();
}
await browser.close();
console.log(fs.readdirSync(out).sort().join("\n"));
