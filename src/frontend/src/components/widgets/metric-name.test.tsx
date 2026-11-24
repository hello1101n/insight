// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { AppTooltips, openTooltip } from "@/test/tooltip";
import { MetricName } from "./metric-name";

describe("MetricName", () => {
  it("writes a name that is never cut once, with no title", () => {
    const { container } = render(<MetricName metric={{ label: "Commits" }} />);

    expect(container.textContent).toBe("Commits");
    expect(screen.getByText("Commits")).not.toHaveAttribute("title");
  });

  it("adds no title when the shown text is the full name", () => {
    render(<MetricName metric={{ label: "Commits" }} text="Commits" />);

    expect(screen.getByText("Commits")).not.toHaveAttribute("title");
  });

  it("titles a cut name with its full name, without repeating it to assistive technology", () => {
    const { container } = render(
      <MetricName metric={{ label: "Meetings and Calls Attended" }} truncate />
    );

    const name = screen.getByText("Meetings and Calls Attended");
    expect(name).toHaveClass("truncate");
    expect(name).toHaveAttribute("title", "Meetings and Calls Attended");
    expect(container.querySelector(".sr-only")).toBeNull();
  });

  it("titles a shortened name with the full name and gives that to assistive technology", () => {
    render(
      <MetricName
        metric={{ label: "Meetings and Calls Attended" }}
        text="Meetings"
      />
    );

    expect(screen.getByText("Meetings")).toHaveAttribute(
      "title",
      "Meetings and Calls Attended"
    );
    expect(screen.getByText("Meetings and Calls Attended")).toHaveClass(
      "sr-only"
    );
  });

  it("opens no tooltip when the pointer rests on a cut name", async () => {
    render(
      <MetricName metric={{ label: "Meetings and Calls Attended" }} truncate />,
      { wrapper: AppTooltips }
    );

    await userEvent.hover(screen.getByText("Meetings and Calls Attended"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(openTooltip()).toBeNull();
  });
});
