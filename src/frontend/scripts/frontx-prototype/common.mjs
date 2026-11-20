// Prototype: helpers the FrontX measurement scripts share.
import { chromium } from "playwright";

export { chromium };

// What each mock board draws, so "drawn" means every cell drew.
export const BOARDS = {
  "delivery-pulse": { cells: 8, charts: 5, tables: 1 },
  "delivery-overview": { cells: 1, charts: 0, tables: 1 },
};

export function args(names) {
  const values = process.argv.slice(2);
  const required = names.filter((name) => !name.endsWith("?"));
  if (values.length < required.length) {
    console.error(`usage: node ${process.argv[1].split("/").pop()} ${names.map((n) => `<${n}>`).join(" ")}`);
    process.exit(2);
  }
  return values;
}

export const boardUrl = (origin, board, frontx) =>
  `${origin}/dashboards/${board}${frontx ? "?frontx=1" : ""}`;

/** The FrontX cell frame that holds a title, or the current page's card. */
export function cardOf(page, title, frontx) {
  if (frontx) return page.locator('[data-cell-frame="card"]').filter({ hasText: title }).first();
  return page
    .getByText(title, { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(@class, "_card_")][1]');
}

/**
 * Runs in the page. Records `__drawnAt`, the first time every expected cell
 * shows drawn content, and `__changedAt`, the last time the drawn text changed.
 */
export function drawnProbe({ frontx, expect }) {
  performance.setResourceTimingBufferSize(5000);
  const hostOf = (frame) => [frame, ...frame.querySelectorAll("*")].find((el) => el.shadowRoot);
  const drawnFrontx = () => {
    const frames = [...document.querySelectorAll('[data-cell-frame="card"]')];
    if (frames.length < expect.cells) return false;
    return frames.every((frame) => {
      if (frame.getAttribute("aria-busy") === "true") return false;
      const root = hostOf(frame)?.shadowRoot;
      if (!root) return frame.textContent.includes("cannot be shown");
      return Boolean(root.querySelector("svg, table, [role=grid]")) || /\d/.test(root.textContent);
    });
  };
  const drawnCurrent = () => {
    const main = document.querySelector("main");
    if (!main || !document.querySelector('[data-testid="page-custom-dashboard"]')) return false;
    if (main.querySelector('[role="status"]')) return false;
    return (
      main.querySelectorAll(".recharts-surface").length >= expect.charts &&
      main.querySelectorAll("table").length >= expect.tables
    );
  };
  const signature = () => {
    if (!frontx) return document.querySelector("main")?.innerText ?? "";
    return [...document.querySelectorAll('[data-cell-frame="card"]')]
      .map((frame) => {
        const host = hostOf(frame);
        if (!host) return frame.textContent;
        return [...host.shadowRoot.children]
          .filter((el) => el.tagName !== "STYLE" && el.tagName !== "LINK")
          .map((el) => el.textContent)
          .join("|");
      })
      .join("#");
  };

  const drawn = frontx ? drawnFrontx : drawnCurrent;
  let last = "";
  window.__changedAt = 0;
  const tick = () => {
    if (window.__drawnAt === undefined && drawn()) window.__drawnAt = performance.now();
    const now = signature();
    if (now !== last) {
      last = now;
      window.__changedAt = performance.now();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__signature = signature;
}

export async function waitDrawn(page, timeoutMs = 30000) {
  await page.waitForFunction(() => window.__drawnAt !== undefined, null, { timeout: timeoutMs });
  return page.evaluate(() => Math.round(window.__drawnAt));
}

/** Used JS heap after a forced garbage collection, in MB. */
export async function heapMb(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  return +(usedSize / 1048576).toFixed(1);
}
