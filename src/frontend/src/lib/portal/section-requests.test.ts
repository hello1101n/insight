import { describe, expect, it } from "vitest";

import { breakdownRequest, heatmapRequest } from "./section-requests";

const SCOPE = [{ dimension: "repository", values: ["repo-a"] }];

describe("breakdownRequest", () => {
  it("two sections on one metric send one entry with both dimensions", () => {
    const request = breakdownRequest(
      [
        {
          kind: "composition",
          metric: "git.prs",
          dimension: "size",
          splitBy: "author_role",
          title: "By size",
        },
        {
          kind: "ownership",
          metric: "git.prs",
          dimension: "repository",
          title: "Ownership",
        },
        {
          kind: "composition",
          metric: "git.commits",
          dimension: "size",
          title: "Commits",
        },
      ],
      SCOPE
    );

    expect(request.metrics).toEqual([
      {
        key: "git.prs",
        filters: SCOPE,
        views: [
          {
            view: "breakdown",
            dimensions: ["size", "author_role", "repository"],
          },
        ],
      },
      {
        key: "git.commits",
        filters: SCOPE,
        views: [{ view: "breakdown", dimensions: ["size"] }],
      },
    ]);
  });
});

describe("heatmapRequest", () => {
  it("the heatmap asks for day buckets split by hour block", () => {
    const request = heatmapRequest(
      [
        {
          kind: "heatmap-hours",
          metric: "git.commits",
          title: "When",
          caption: "",
        },
      ],
      undefined
    );

    expect(request.metrics).toEqual([
      {
        key: "git.commits",
        views: [
          { view: "timeseries", bucket: "day", dimensions: ["hour_block"] },
        ],
      },
    ]);
  });
});
