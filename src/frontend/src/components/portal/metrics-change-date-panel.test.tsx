import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { TeamTimeWeeks } from "@/lib/portal/metrics-team-time";

import { MetricsChangeDatePanel } from "./metrics-change-date-panel";

function renderPanel(weeks: TeamTimeWeeks = 2) {
  const onChange = vi.fn();
  const onWeeks = vi.fn();
  render(
    <MetricsChangeDatePanel
      change="2026-10-15"
      weeks={weeks}
      latest="2026-10-20"
      onChange={onChange}
      onWeeks={onWeeks}
    />,
  );
  return { onChange, onWeeks };
}

describe("MetricsChangeDatePanel", () => {
  it("names the change date and opens the calendar on its month, with the date marked", () => {
    renderPanel();

    expect(screen.getByRole("heading", { name: "Change date · 15 Oct" })).toBeInTheDocument();
    expect(screen.getByText("October 2026")).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { selected: true })).toHaveTextContent("15");
  });

  it("presses the window length the view uses", () => {
    renderPanel(4);

    expect(screen.getByRole("button", { name: "4 weeks" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "2 weeks" })).toHaveAttribute("aria-pressed", "false");
  });

  it("sets the window length when one is picked", async () => {
    const { onWeeks } = renderPanel();

    await userEvent.click(screen.getByRole("button", { name: "1 week" }));

    expect(onWeeks).toHaveBeenCalledWith(1);
  });

  it("sets the change date to the day clicked", async () => {
    const { onChange } = renderPanel();

    await userEvent.click(screen.getByRole("button", { name: /October 6th, 2026/ }));

    expect(onChange).toHaveBeenCalledWith("2026-10-06");
  });

  it("offers no day whose After period is not over yet", () => {
    renderPanel();

    expect(screen.getByRole("button", { name: /October 20th, 2026/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /October 21st, 2026/ })).toBeDisabled();
  });

  it("turns the calendar to the month of a change date set from elsewhere", () => {
    const view = render(
      <MetricsChangeDatePanel
        change="2026-10-15"
        weeks={2}
        latest="2026-11-20"
        onChange={vi.fn()}
        onWeeks={vi.fn()}
      />,
    );

    view.rerender(
      <MetricsChangeDatePanel
        change="2026-11-14"
        weeks={2}
        latest="2026-11-20"
        onChange={vi.fn()}
        onWeeks={vi.fn()}
      />,
    );

    expect(screen.getByText("November 2026")).toBeInTheDocument();
  });
});
