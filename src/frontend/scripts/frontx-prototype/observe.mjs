// Prototype: the current renderer against FrontX on the mock boards.
// Time to the last cell drawn, heap, requests by kind, a range change, a
// theme switch and a board switch. Writes report.json and screenshots.
// Usage: node observe.mjs <origin> <out-dir> [runs]
import fs from "node:fs";
import path from "node:path";

import { args, BOARDS, boardUrl, chromium, drawnProbe, heapMb, waitDrawn } from "./common.mjs";

const [origin, out, runsArg = "1"] = args(["origin", "out-dir", "runs?"]);
const RUNS = Number(runsArg);
fs.mkdirSync(out, { recursive: true });

function kindOf(url) {
  const { pathname } = new URL(url);
  if (/\/api\/v3\/v1\/dashboards\/[^/]+\/widgets\/[^/]+\/run$/.test(pathname)) return "data";
  if (pathname === "/widgets/widgets.json" || pathname.endsWith("/widget.gts.json")) return "widgetParts";
  if (pathname.startsWith("/widgets/")) return "widgetCode";
  if (pathname.startsWith("/api/") || pathname.startsWith("/auth/")) return "otherApi";
  return "app";
}

function counter(page) {
  const counts = { data: 0, widgetParts: 0, widgetCode: 0, otherApi: 0, app: 0, widgetBytes: 0 };
  const urls = [];
  page.on("requestfinished", async (request) => {
    const kind = kindOf(request.url());
    counts[kind] += 1;
    if (kind.startsWith("widget")) {
      urls.push(`${kind} ${new URL(request.url()).pathname}`);
      const response = await request.response();
      const body = response ? await response.body().catch(() => null) : null;
      if (body) counts.widgetBytes += body.length;
    }
  });
  const take = () => {
    const snapshot = { ...counts, widgetKB: Math.round(counts.widgetBytes / 1024) };
    delete snapshot.widgetBytes;
    for (const key of Object.keys(counts)) counts[key] = 0;
    return { ...snapshot, widgetUrls: urls.splice(0) };
  };
  return { take };
}

async function visit(browser, board, frontx, scheme, shoot) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 2400 }, colorScheme: scheme });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" || (m.type() === "warning" && !text.includes("[MSW]"))) errors.push(`${m.type()}: ${text.slice(0, 300)}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  await page.addInitScript(drawnProbe, { frontx, expect: BOARDS[board] });
  const requests = counter(page);

  await page.goto(boardUrl(origin, board, frontx));
  const drawnMs = await waitDrawn(page).catch(() => "timeout");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  const load = requests.take();
  const heap = await heapMb(cdp);
  const name = `${board}-${frontx ? "frontx" : "current"}-${scheme}`;
  if (shoot) await page.screenshot({ path: path.join(out, `${name}.png`) });
  return { page, context, cdp, requests, result: { name, drawnMs, heapMb: heap, load, errors } };
}

async function rangeChange(page, requests) {
  const before = await page.evaluate(() => performance.now());
  await page.getByRole("button", { name: "Last 7 days" }).click();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(3000);
  const changedAt = await page.evaluate(() => window.__changedAt);
  return { lastChangeAfterClickMs: Math.round(changedAt - before), requests: requests.take() };
}

async function themeSwitch(page, requests) {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(800);
  return { theme: await page.evaluate(() => document.documentElement.dataset.theme), requests: requests.take() };
}

async function boardSwitch(browser) {
  const v = await visit(browser, "delivery-pulse", true, "light", false);
  const go = async (to) => {
    await v.page.evaluate((target) => {
      history.pushState({}, "", target);
      dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    }, to);
    await v.page.waitForLoadState("networkidle");
    await v.page.waitForTimeout(2500);
    return { to, requests: v.requests.take(), heapMb: await heapMb(v.cdp) };
  };
  const steps = [];
  for (const to of ["/dashboards/delivery-overview?frontx=1", "/dashboards/delivery-pulse?frontx=1", "/dashboards/delivery-overview?frontx=1"]) {
    steps.push(await go(to));
  }
  await v.context.close();
  return steps;
}

const browser = await chromium.launch();
const report = { origin, runs: RUNS, visits: [], interactions: [] };

// One warm-up load per renderer, not reported.
for (const frontx of [false, true]) {
  const warm = await visit(browser, "delivery-pulse", frontx, "light", false);
  await warm.context.close();
}

// The sides alternate inside each run, so drift and noise favour neither.
for (let run = 0; run < RUNS; run += 1) {
  for (const board of Object.keys(BOARDS)) {
    for (const scheme of ["light", "dark"]) {
      for (const frontx of [false, true]) {
        const v = await visit(browser, board, frontx, scheme, run === 0);
        report.visits.push({ run, ...v.result });
        await v.context.close();
      }
    }
  }
}

for (const frontx of [false, true]) {
  const v = await visit(browser, "delivery-pulse", frontx, "light", false);
  v.requests.take();
  const range = await rangeChange(v.page, v.requests);
  const theme = await themeSwitch(v.page, v.requests);
  report.interactions.push({ renderer: frontx ? "frontx" : "current", range, theme });
  await v.context.close();
}
report.interactions.push({ renderer: "frontx", boardSwitch: await boardSwitch(browser) });

fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const byName = Object.groupBy(report.visits, (v) => v.name);
for (const [name, visits] of Object.entries(byName)) {
  const drawn = visits.map((v) => v.drawnMs).filter((ms) => typeof ms === "number");
  const errors = visits.flatMap((v) => v.errors).filter((e) => !e.includes("Failed to load resource"));
  const { widgetUrls: _, ...load } = visits[0].load;
  console.log(
    `${name}: drawn median ${median(drawn)} ms (${Math.min(...drawn)}-${Math.max(...drawn)}, n=${drawn.length}), heap ${median(visits.map((v) => v.heapMb))} MB, ${JSON.stringify(load)}, console errors ${errors.length}`
  );
}
for (const interaction of report.interactions) console.log(JSON.stringify(interaction, (k, v) => (k === "widgetUrls" ? v.length : v)));
await browser.close();
