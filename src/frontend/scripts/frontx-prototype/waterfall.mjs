// Prototype: the request phases and a CPU profile of one board load, to name the limiter.
// Usage: node waterfall.mjs <origin> <board> [frontx: 0|1]
import { args, BOARDS, boardUrl, chromium, drawnProbe, waitDrawn } from "./common.mjs";

const [origin, board, frontxArg = "0"] = args(["origin", "board", "frontx?"]);
const frontx = frontxArg === "1";

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 2400 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await page.addInitScript(drawnProbe, { frontx, expect: BOARDS[board] });

await cdp.send("Profiler.start");
await page.goto(boardUrl(origin, board, frontx));
const drawn = await waitDrawn(page);
const { profile } = await cdp.send("Profiler.stop");

const entries = await page.evaluate(() =>
  performance.getEntriesByType("resource").map((e) => ({ name: new URL(e.name).pathname, start: e.startTime, end: e.responseEnd }))
);
const phaseOf = (name) => {
  if (/\/run$/.test(name)) return "data";
  if (name.startsWith("/widgets/")) return name.endsWith(".json") ? "widget parts" : "widget code";
  if (name.startsWith("/api/") || name.startsWith("/auth/")) return "other api";
  return name.includes("frontx-board") ? "frontx chunk" : "app";
};
const phases = {};
for (const e of entries) {
  const phase = (phases[phaseOf(e.name)] ??= { count: 0, firstStart: Infinity, lastEnd: 0 });
  phase.count += 1;
  phase.firstStart = Math.min(phase.firstStart, e.start);
  phase.lastEnd = Math.max(phase.lastEnd, e.end);
}
console.log(`drawn at ${drawn} ms`);
for (const [phase, s] of Object.entries(phases)) {
  console.log(`${phase.padEnd(13)} n ${String(s.count).padStart(3)}  ${Math.round(s.firstStart)}-${Math.round(s.lastEnd)} ms`);
}

// Self time by script, from the CPU profile.
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const selfMs = {};
profile.samples.forEach((id, i) => {
  const { url, functionName } = nodes.get(id).callFrame;
  const key = url ? new URL(url).pathname.replace(/-[A-Za-z0-9_-]{8}\.js$/, ".js") : `(${functionName || "native"})`;
  selfMs[key] = (selfMs[key] ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000;
});
console.log(`cpu profile ${Math.round(Object.values(selfMs).reduce((a, b) => a + b, 0))} ms, top self time:`);
for (const [key, ms] of Object.entries(selfMs).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`${String(Math.round(ms)).padStart(6)}  ${key}`);
}
await browser.close();
