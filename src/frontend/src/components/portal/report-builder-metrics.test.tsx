import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { MetricFamily } from "@/lib/reports/families";

import {
  ReportMetricPicker,
  type OfferedReportMetric,
} from "./report-builder-metrics";

function metric(
  key: string,
  label: string,
  description: string | null,
  explanation: string | null = null,
): OfferedReportMetric {
  return {
    metric_key: key,
    label,
    description,
    explanation,
    unit: null,
    format: "integer",
    reason: null,
  } as unknown as OfferedReportMetric;
}

const families = [
  {
    family: "git",
    name: "Development · Git",
    metrics: [
      metric("git.review", "Review turnaround", "Hours until the first human review."),
      metric("git.blank", "Blank metric", ""),
      metric("git.none", "Null metric", null),
      metric("git.spaces", "Spaces metric", "   "),
      metric(
        "git.cycle",
        "PR cycle time",
        "Typical hours from open to merge",
        "Median hours from opening a pull request to merging it.",
      ),
      metric("git.only", "Explained metric", null, "Median count of reviews per pull request."),
    ],
  },
] as unknown as MetricFamily<OfferedReportMetric>[];

function Harness() {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <ReportMetricPicker
      families={families}
      selected={selected}
      setSelected={setSelected}
    />
  );
}

describe("ReportMetricPicker description button", () => {
  it("offers a button named after the metric when it has a description", () => {
    render(<Harness />);

    expect(
      screen.getByRole("button", { name: "About Review turnaround" }),
    ).toBeInTheDocument();
  });

  it("shows the label and the description from that button, and leaves the checkbox alone", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "About Review turnaround" }));

    expect(screen.getByText("Hours until the first human review.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Review turnaround/ })).not.toBeChecked();
  });

  it("closes the card from its close button", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "About Review turnaround" }));
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByText("Hours until the first human review.")).not.toBeInTheDocument();
  });

  it("offers no button when the description is null or empty", () => {
    render(<Harness />);

    expect(screen.queryByRole("button", { name: "About Blank metric" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "About Null metric" })).not.toBeInTheDocument();
  });

  it("shows the explanation under the description", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "About PR cycle time" }));

    expect(screen.getByText("Typical hours from open to merge")).toBeInTheDocument();
    expect(
      screen.getByText("Median hours from opening a pull request to merging it."),
    ).toBeInTheDocument();
  });

  it("offers the button and shows the explanation when only the explanation is set", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "About Explained metric" }));

    expect(screen.getByText("Median count of reviews per pull request.")).toBeInTheDocument();
  });

  it("offers no button when the description is only spaces", () => {
    render(<Harness />);

    expect(screen.queryByRole("button", { name: "About Spaces metric" })).not.toBeInTheDocument();
  });
});

describe("ReportMetricPicker row click", () => {
  it("toggles the checkbox when the unit tag is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getAllByText("integer")[0]);

    expect(screen.getByRole("checkbox", { name: /Review turnaround/ })).toBeChecked();
  });
});
