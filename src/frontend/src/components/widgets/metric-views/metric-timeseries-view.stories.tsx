import type { ReactNode } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor } from "storybook/test";

import type { MetricEvidenceSelection } from "@/api/metric-drilldown-client";
import {
  EvidenceDialogContext,
  type EvidenceDialogTarget,
} from "@/components/metric-evidence-context";
import { MetricTimeseriesView } from "@/components/widgets/metric-views/metric-timeseries-view";
import {
  BUCKETS,
  COMMITS,
  ENTITY_ID,
  LINES_ADDED,
  metricResultsHandler,
  RANGE,
} from "@/components/widgets/metric-views/metric-timeseries.story-fixtures";
import {
  CARD_PX_AT_390,
  expectHorizontallyContained,
  expectNothingOverlaps,
} from "@/test/storybook/layout";

const TOP_REPOSITORIES = {
  default: "repository",
  limits: {
    repository: {
      count: 2,
      rankBy: COMMITS,
      includeRemainder: true,
    },
  },
};

const REPOSITORY_AND_SOURCE = { default: "repository", options: ["source"] };

interface CapturedDownload {
  filename: string;
  blob: Blob;
}

const downloads: CapturedDownload[] = [];

const retryState = { failing: true };

function captureDownloads(): () => void {
  downloads.length = 0;
  const blobs = new Map<string, Blob>();
  const createObjectURL = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;

  URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = createObjectURL.call(URL, object);
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    const blob = this.download ? blobs.get(this.href) : undefined;
    if (!blob) {
      originalClick.call(this);
      return;
    }
    downloads.push({ filename: this.download, blob });
  };

  return () => {
    URL.createObjectURL = createObjectURL;
    HTMLAnchorElement.prototype.click = originalClick;
  };
}

async function openExportMenu(): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
}

const drilled: MetricEvidenceSelection[][] = [];

function captureDrilldowns(Story: () => ReactNode) {
  drilled.length = 0;
  return (
    <EvidenceDialogContext.Provider
      value={{
        openEvidence: (selection) => drilled.push([selection]),
        openEvidenceTargets: (targets: readonly EvidenceDialogTarget[]) =>
          drilled.push(targets.map((target) => target.selection)),
        openEvidencePeople: () => {},
      }}
    >
      <Story />
    </EvidenceDialogContext.Provider>
  );
}

const barSegments = (canvasElement: HTMLElement): HTMLElement[] => [
  ...canvasElement.querySelectorAll<HTMLElement>(".recharts-bar-rectangle"),
];

interface ChartPoint {
  clientX: number;
  clientY: number;
}

const centreOf = (element: Element): ChartPoint => {
  const box = element.getBoundingClientRect();
  return {
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
  };
};

function emptySpotInBucket(
  canvasElement: HTMLElement,
  bucketIndex: number
): ChartPoint {
  const plot = canvasElement
    .querySelector(".recharts-cartesian-grid")!
    .getBoundingClientRect();
  return {
    clientX: plot.left + (plot.width / BUCKETS.length) * (bucketIndex + 0.5),
    clientY: plot.top + 4,
  };
}

// WORKAROUND: Recharts reads the pointer position off its wrapper, and a
// dispatched event bubbles up to it but never back down, so target what a
// real pointer would be over.
const pointAt = (target: Element, coords: ChartPoint) =>
  userEvent.pointer({ target, coords });

const clickAt = (target: Element, coords: ChartPoint) =>
  userEvent.pointer([
    { target, coords },
    { keys: "[MouseLeft]", target, coords },
  ]);

const meta: Meta<typeof MetricTimeseriesView> = {
  title: "Widgets/MetricViews/MetricTimeseriesView",
  component: MetricTimeseriesView,
  args: {
    id: "git-output",
    entityId: ENTITY_ID,
    range: RANGE,
    metricKeys: [COMMITS, LINES_ADDED],
  },
  parameters: { msw: { handlers: [metricResultsHandler()] } },
  // WORKAROUND: Recharts' ResponsiveContainer measures 0 wide without a sized parent.
  decorators: [
    (Story) => (
      <div className="w-[900px]">
        <Story />
      </div>
    ),
  ],
};
export default meta;

type Story = StoryObj<typeof MetricTimeseriesView>;

export const Chart: Story = {
  args: { groupBy: TOP_REPOSITORIES },
};

export const Table: Story = {
  args: { groupBy: TOP_REPOSITORIES, defaultPresentation: "table" },
};

export const GroupedAndFilterable: Story = {
  args: { groupBy: REPOSITORY_AND_SOURCE },
};

export const Loading: Story = {
  parameters: {
    msw: { handlers: [metricResultsHandler({ kind: "pending" })] },
  },
};

export const LoadFailed: Story = {
  parameters: { msw: { handlers: [metricResultsHandler({ kind: "error" })] } },
};

export const NoData: Story = {
  parameters: { msw: { handlers: [metricResultsHandler({ kind: "empty" })] } },
};

export const TestChartPresentation: Story = {
  tags: ["test"],
  args: { groupBy: TOP_REPOSITORIES },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByText("org/repo-a")).toBeInTheDocument();
    await expect(canvas.getByText("Weekly by repository")).toBeInTheDocument();
    await expect(canvas.getByText("org/repo-b")).toBeInTheDocument();
    await expect(canvas.getByText("Other")).toBeInTheDocument();
    await expect(canvas.queryByText("org/repo-c")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(canvasElement.querySelector("svg.recharts-surface")).toBeTruthy()
    );
  },
};

export const TestColumnClickDrilldown: Story = {
  tags: ["test"],
  args: { id: "column-click", groupBy: TOP_REPOSITORIES },
  decorators: [captureDrilldowns],
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByText("org/repo-a");
    await waitFor(() =>
      expect(barSegments(canvasElement).length).toBeGreaterThan(2)
    );

    const wrapper = canvasElement.querySelector<HTMLElement>(
      ".recharts-wrapper"
    )!;
    // WORKAROUND: Recharts rebuilds its rectangles as the pointer moves, so a
    // segment held across one gesture is a detached node by the next.
    const segment = () => barSegments(canvasElement)[0]!;

    wrapper.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        clientX: wrapper.getBoundingClientRect().left + 4,
        clientY: wrapper.getBoundingClientRect().top + 4,
      })
    );

    await clickAt(segment(), centreOf(segment()));
    await waitFor(() => expect(drilled).toHaveLength(1));
    await expect(drilled[0]?.[0]).toMatchObject({
      metric_key: COMMITS,
      period: { from: "2026-04-20", to: "2026-04-26" },
      filters: [{ dimension: "repository", values: ["org/repo-a"] }],
    });

    const spot = emptySpotInBucket(canvasElement, 1);
    await pointAt(wrapper, spot);
    await waitFor(() =>
      expect(canvas.getByText("April 27, 2026")).toBeInTheDocument()
    );

    await clickAt(wrapper, spot);
    await waitFor(() => expect(drilled).toHaveLength(2));
    await expect(drilled[1]?.[0]).toMatchObject({
      metric_key: COMMITS,
      period: { from: "2026-04-27", to: "2026-05-03" },
      filters: [],
    });

    await expect(drilled).toHaveLength(2);
  },
};

export const TestLineClickDrilldown: Story = {
  tags: ["test"],
  args: { id: "line-click", chart: { multiMetric: "combined" } },
  decorators: [captureDrilldowns],
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByText("Commits & Lines added");
    await waitFor(() =>
      expect(canvasElement.querySelector(".recharts-line-curve")).toBeTruthy()
    );

    const wrapper = canvasElement.querySelector<HTMLElement>(
      ".recharts-wrapper"
    )!;
    const spot = emptySpotInBucket(canvasElement, 1);
    await pointAt(wrapper, spot);
    await waitFor(() =>
      expect(canvas.getByText("April 27, 2026")).toBeInTheDocument()
    );

    await clickAt(wrapper, spot);

    await waitFor(() => expect(drilled).toHaveLength(1));
    const bucket = { from: "2026-04-27", to: "2026-05-03" };
    await expect(drilled[0]?.[0]).toMatchObject({
      metric_key: COMMITS,
      period: bucket,
      filters: [],
    });
    await expect(drilled[0]?.map((selection) => selection.metric_key)).toEqual([
      COMMITS,
      LINES_ADDED,
    ]);
    await expect(
      drilled[0]?.map((selection) => selection.period)
    ).toEqual([bucket, bucket]);
  },
};

export const TestPresentationToggle: Story = {
  tags: ["test"],
  args: { id: "toggle", groupBy: TOP_REPOSITORIES },
  play: async ({ canvas }) => {
    await canvas.findByText("org/repo-a");

    await userEvent.click(canvas.getByRole("button", { name: "Table view" }));
    await expect(canvas.getByText("Week")).toBeInTheDocument();
    await expect(canvas.getByText("Total")).toBeInTheDocument();
    await expect(
      canvas.getByText("Grand total").closest("tr")
    ).toHaveTextContent("Commits: 10");
    await expect(
      canvas.queryByText("Weekly by repository")
    ).not.toBeInTheDocument();
    await expect(
      window.localStorage.getItem("insight.timeseries.toggle.presentation")
    ).toBe("table");

    await userEvent.click(canvas.getByRole("button", { name: "Chart view" }));
    await expect(canvas.getByText("Weekly by repository")).toBeInTheDocument();
    await expect(
      window.localStorage.getItem("insight.timeseries.toggle.presentation")
    ).toBe("chart");
  },
};

export const TestPersistedPresentation: Story = {
  tags: ["test"],
  args: { id: "persisted", defaultPresentation: "chart" },
  beforeEach: () => {
    window.localStorage.setItem(
      "insight.timeseries.persisted.presentation",
      "table"
    );
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Week")).toBeInTheDocument();
    await expect(canvas.queryByText("Weekly")).not.toBeInTheDocument();
  },
};

export const TestMetricSelect: Story = {
  tags: ["test"],
  args: { groupBy: TOP_REPOSITORIES },
  play: async ({ canvas }) => {
    const trigger = await canvas.findByLabelText("Metric");
    await expect(trigger).toHaveTextContent("Commits");

    await userEvent.click(trigger);
    await userEvent.click(
      await screen.findByRole("option", { name: "Lines added" })
    );

    await expect(canvas.getByLabelText("Metric")).toHaveTextContent(
      "Lines added"
    );
  },
};

export const TestCombinedMetrics: Story = {
  tags: ["test"],
  args: { chart: { multiMetric: "combined" } },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText("Commits & Lines added")
    ).toBeInTheDocument();
    await expect(canvas.queryByLabelText("Metric")).not.toBeInTheDocument();
    await expect(canvas.getByText("Weekly")).toBeInTheDocument();
  },
};

export const TestGroupByAndFilters: Story = {
  tags: ["test"],
  args: { groupBy: REPOSITORY_AND_SOURCE },
  play: async ({ canvas }) => {
    await canvas.findByText("org/repo-a");

    await userEvent.click(canvas.getByRole("button", { name: "Filters" }));
    await userEvent.click(
      await screen.findByRole("checkbox", { name: "GitLab" })
    );
    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(canvas.queryByText("org/repo-a")).not.toBeInTheDocument()
    );
    await expect(canvas.getByText("org/repo-c")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Clear Source filter" })
    ).toHaveTextContent("Source: GitLab");

    await userEvent.click(
      canvas.getByRole("button", { name: "Clear Source filter" })
    );
    await waitFor(() =>
      expect(canvas.getByText("org/repo-a")).toBeInTheDocument()
    );

    await userEvent.click(canvas.getByRole("button", { name: "Source" }));
    await expect(await canvas.findByText("GitHub")).toBeInTheDocument();
    await expect(canvas.getByText("GitLab")).toBeInTheDocument();
    await expect(canvas.getByText("Weekly by source")).toBeInTheDocument();
  },
};

export const TestRevalidating: Story = {
  tags: ["test"],
  args: { groupBy: REPOSITORY_AND_SOURCE },
  parameters: {
    msw: { handlers: [metricResultsHandler({ kind: "data", delayMs: 800 })] },
  },
  play: async ({ canvas, canvasElement }) => {
    await canvas.findByText("org/repo-a");

    await userEvent.click(canvas.getByRole("button", { name: "Source" }));
    await waitFor(() =>
      expect(canvasElement.querySelector('[aria-busy="true"]')).toBeTruthy()
    );
    await expect(canvas.getByRole("button", { name: "Export" })).toBeDisabled();
    await expect(canvas.getByText("org/repo-a")).toBeInTheDocument();

    await waitFor(() =>
      expect(canvas.getByText("GitHub")).toBeInTheDocument()
    );
    await expect(canvas.getByRole("button", { name: "Export" })).toBeEnabled();
  },
};

export const TestLoading: Story = {
  tags: ["test"],
  parameters: {
    msw: { handlers: [metricResultsHandler({ kind: "pending" })] },
  },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("status", { name: "Loading" })
    ).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Export" })).toBeDisabled();
    await expect(
      canvas.queryByText("No data in this period")
    ).not.toBeInTheDocument();
  },
};

export const TestErrorAndRetry: Story = {
  tags: ["test"],
  args: { groupBy: TOP_REPOSITORIES },
  parameters: {
    msw: {
      handlers: [
        metricResultsHandler({ kind: "recovering", state: retryState }),
      ],
    },
  },
  beforeEach: () => {
    retryState.failing = true;
  },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText("Unable to load timeseries")
    ).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Export" })).toBeDisabled();

    retryState.failing = false;
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));

    await expect(await canvas.findByText("org/repo-a")).toBeInTheDocument();
    await expect(canvas.getByText("Weekly by repository")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Export" })).toBeEnabled();
  },
};

export const TestEmpty: Story = {
  tags: ["test"],
  parameters: { msw: { handlers: [metricResultsHandler({ kind: "empty" })] } },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText("No data in this period")
    ).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Export" })).toBeDisabled();
  },
};

export const TestCsvExport: Story = {
  tags: ["test"],
  args: { groupBy: TOP_REPOSITORIES },
  beforeEach: () => captureDownloads(),
  play: async ({ canvas }) => {
    await canvas.findByText("org/repo-a");

    await openExportMenu();
    await userEvent.click(await screen.findByText("CSV (.csv)"));

    await waitFor(() => expect(downloads).toHaveLength(1));
    const download = downloads[0]!;
    await expect(download.filename).toBe(
      "git-output_2026-04-20_2026-05-04.csv"
    );
    const text = await download.blob.text();
    await expect(text).toContain(
      "Week,org/repo-a — Commits,org/repo-a — Lines added,org/repo-b — Commits,org/repo-b — Lines added,Other — Commits,Other — Lines added"
    );
    await expect(text).toContain("2026-04-20,3,30,2,18,1,11");
    await expect(text).toContain("2026-04-27,0,0,,,1,6");
    await expect(text).not.toContain("Grand total");
  },
};

export const TestXlsxExport: Story = {
  tags: ["test"],
  args: { groupBy: TOP_REPOSITORIES },
  beforeEach: () => captureDownloads(),
  play: async ({ canvas }) => {
    await canvas.findByText("org/repo-a");

    await openExportMenu();
    await userEvent.click(await screen.findByText("Excel (.xlsx)"));

    await waitFor(() => expect(downloads).toHaveLength(1));
    const download = downloads[0]!;
    await expect(download.filename).toBe(
      "git-output_2026-04-20_2026-05-04.xlsx"
    );

    const { Workbook } = await import("exceljs");
    const workbook = new Workbook();
    await workbook.xlsx.load(await download.blob.arrayBuffer());
    const sheet = workbook.getWorksheet("Timeseries");

    await expect(sheet?.getCell("A1").value).toBe("Week");
    await expect(sheet?.getCell("B1").value).toBe("org/repo-a");
    await expect(sheet?.getCell("B2").value).toBe("Commits");
    await expect(sheet?.getCell("C2").value).toBe("Lines added");
    await expect(sheet?.getCell("F1").value).toBe("Other");
    await expect(sheet?.getCell("A3").value).toBe("2026-04-20");
    await expect(sheet?.getCell("B6").value).toBe(5);
    await expect(sheet?.getCell("A6").value).toBe("Total");
    await expect(sheet?.getCell("A7").value).toBe("Grand total");
    await expect(sheet?.getCell("B7").value).toBe(
      "Commits: 10 · Lines added: 98"
    );
    await expect(sheet?.views[0]).toMatchObject({ xSplit: 1, ySplit: 2 });
  },
};

export const TestNarrowHeaderStacksInsteadOfOverlapping: Story = {
  tags: ["test"],
  args: { groupBy: TOP_REPOSITORIES, defaultPresentation: "table" },
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_AT_390 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const title = await canvas.findByRole("heading", {
      name: /By repository/,
    });
    const header = title.parentElement?.parentElement ?? null;
    await expect(header, "the card renders a header row").not.toBeNull();
    const controls = Array.from(header!.querySelectorAll("button"));

    await expect(controls.length, "the header has controls to clear").toBeGreaterThan(0);
    expectNothingOverlaps(title, controls, (element) =>
      element.getAttribute("aria-label") ?? element.textContent ?? "a control"
    );

    const label = title.querySelector("span");
    await expect(label, "the title renders its truncating span").not.toBeNull();
    await expect(
      label!.scrollWidth,
      `the title is clipped (${label!.scrollWidth}px of text in ${label!.clientWidth}px)`
    ).toBeLessThanOrEqual(label!.clientWidth);
  },
};

export const TestNarrowTableKeepsItsScrollControlsOffTheCells: Story = {
  tags: ["test"],
  args: { groupBy: TOP_REPOSITORIES, defaultPresentation: "table" },
  decorators: [
    (Story) => (
      <div style={{ width: CARD_PX_AT_390 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvas }) => {
    const table = await canvas.findByRole("table");
    const scrollport = table.parentElement!;
    const controlsNow = () =>
      canvas.getAllByRole("button", { name: /^Show (earlier|later) / });
    await canvas.findAllByRole("button", {
      name: /^Show (earlier|later) /,
    });

    await expect(
      controlsNow().length,
      "the table has scroll controls to clear"
    ).toBeGreaterThan(0);
    expectNothingOverlaps(scrollport, controlsNow(), (element) =>
      element.getAttribute("aria-label") ?? "a scroll control"
    );

    const firstValue = table.querySelectorAll("tbody tr td")[0];
    expectHorizontallyContained(
      scrollport,
      [table.querySelector("tbody th, tbody tr > *:first-child")!, firstValue],
      (element) => `the ${element.tagName.toLowerCase()} in the first row`
    );

    const before = scrollport.getBoundingClientRect().width;
    await userEvent.click(
      canvas.getByRole("button", { name: "Show later columns" })
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Show earlier columns" })
      ).toBeVisible()
    );

    expectNothingOverlaps(scrollport, controlsNow(), (element) =>
      element.getAttribute("aria-label") ?? "a scroll control"
    );
    await expect(
      scrollport.getBoundingClientRect().width,
      "the scrollport resized when a control appeared"
    ).toBe(before);
  },
};

