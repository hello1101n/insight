// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sparkline } from "./sparkline";

function paths(container: HTMLElement) {
  return [...container.querySelectorAll("path")];
}

describe("Sparkline", () => {
  it("draws nothing that cannot be scaled", () => {
    expect(render(<Sparkline points={[5]} />).container).toBeEmptyDOMElement();
    expect(
      render(<Sparkline points={[null, null]} />).container
    ).toBeEmptyDOMElement();
  });

  it("breaks the line at a gap instead of dropping it to the floor", () => {
    const { container } = render(<Sparkline points={[10, null, 12, 11]} />);
    expect(paths(container)).toHaveLength(1);

    const split = render(<Sparkline points={[10, 9, null, 12, 11]} />);
    expect(paths(split.container)).toHaveLength(2);
  });

  it("survives a series that never moves", () => {
    const { container } = render(<Sparkline points={[7, 7, 7]} />);
    const d = paths(container)[0]?.getAttribute("d") ?? "";
    expect(d).toMatch(/^M/);
    expect(d).not.toMatch(/NaN|Infinity/);
  });

  it("marks the end of the line, and marks the last reading when it ends in a gap", () => {
    const { container } = render(<Sparkline points={[1, 2, 3]} />);
    expect(container.querySelectorAll("circle")).toHaveLength(1);

    const trailing = render(<Sparkline points={[1, 2, 3, null]} />);
    const dot = trailing.container.querySelector("circle");
    expect(dot).not.toBeNull();
    expect(Number(dot?.getAttribute("cx"))).toBeLessThan(72);
  });

  it("keeps its baseline out of the reading of values", () => {
    const { container } = render(<Sparkline points={[80, 84, 82]} />);
    const rule = container.querySelector("line");
    expect(rule?.getAttribute("x1")).toBe("0");
    expect(rule?.getAttribute("x2")).toBe("72");
  });
});
