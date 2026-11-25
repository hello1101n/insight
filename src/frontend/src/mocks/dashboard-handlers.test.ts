import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DashboardWidget } from "@/api/custom-client";
import { drawnColumns } from "@/lib/custom/draws-bucket";

import { dashboardHandlers } from "./dashboard-handlers";
import { EXAMPLE_DASHBOARDS } from "./example-dashboards";

const server = setupServer(...dashboardHandlers);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const call = (path: string, method = "GET") =>
  fetch(new URL(`/api/v3/v1${path}`, window.location.href), { method });

describe("dashboard mocks", () => {
  it.each([
    [
      "/dashboards/review-health/grants",
      "GET",
      "only the owner or an editor can change this dashboard",
    ],
    [
      "/folders/folder-handover",
      "DELETE",
      "only the owner can delete this folder",
    ],
  ])(
    "refuse %s %s with the reason the service names",
    async (path, method, reason) => {
      const response = await call(path, method);

      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toEqual({
        detail: "You do not have permission to perform this operation",
        context: { reason },
      });
    }
  );

  it("refuses an owned dashboard in an ownerless folder as the wrong shelf", async () => {
    const response = await call(
      "/folders/folder-archive/dashboards/delivery-overview",
      "PUT"
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      context: { violations: { type: string }[] };
    };
    expect(body.context.violations[0]?.type).toBe("wrong_shelf");
  });

  it("dates every orphaned folder", async () => {
    const response = await call("/orphaned-folders");
    const body = (await response.json()) as {
      items: { updated_at?: string }[];
    };

    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((item) => item.updated_at)).toBe(true);
  });

  it("pins and unpins a dashboard the caller sees", async () => {
    expect((await call("/pins/delivery-overview", "PUT")).status).toBe(204);
    const pinned = (await (await call("/pins")).json()) as {
      pins: { id: string }[];
    };
    expect(pinned.pins.map((pin) => pin.id)).toEqual(["delivery-overview"]);

    expect((await call("/pins/delivery-overview", "DELETE")).status).toBe(204);
    const unpinned = (await (await call("/pins")).json()) as { pins: [] };
    expect(unpinned.pins).toEqual([]);
  });

  it("runs only a widget the dashboard draws", async () => {
    const ran = await call(
      "/dashboards/delivery-overview/widgets/deploys-per-week/run",
      "POST"
    );
    expect(ran.status).toBe(200);
    expect(await ran.json()).toMatchObject({ columns: ["week", "deploys"] });

    const stranger = await call(
      "/dashboards/review-health/widgets/deploys-per-week/run",
      "POST"
    );
    expect(stranger.status).toBe(404);
  });
});

const REFUSED: Record<string, number> = {
  "edge-failed": 500,
  "edge-busy": 429,
};
const MISNAMED = new Set(["edge-missing-column"]);

describe("example dashboard mocks", () => {
  it.each(Object.keys(EXAMPLE_DASHBOARDS))(
    "%s runs every widget it draws with the columns and percents the widget names",
    async (board) => {
      const listed = (await (
        await call(`/dashboards/${board}/widgets`)
      ).json()) as { items: DashboardWidget[] };

      for (const widget of listed.items) {
        const ran = await call(
          `/dashboards/${board}/widgets/${widget.id}/run`,
          "POST"
        );
        if (REFUSED[widget.id]) {
          expect(ran.status, widget.id).toBe(REFUSED[widget.id]);
          continue;
        }

        const answer = (await ran.json()) as {
          columns: string[];
          percents?: string[];
        };
        const missing = drawnColumns(widget.body).filter(
          (name) => !answer.columns.includes(name)
        );
        expect(missing.length > 0, widget.id).toBe(MISNAMED.has(widget.id));
        expect(answer.percents, widget.id).toEqual(widget.percents);
      }
    }
  );
});
