// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PersonCoverage } from "./person-coverage";

describe("PersonCoverage", () => {
  it("says nothing when every section reads", () => {
    const { container } = render(
      <PersonCoverage unmeasured={[]} inactive={[]} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("blames the instrument only where the pool is empty too", () => {
    render(<PersonCoverage unmeasured={["Task delivery"]} inactive={[]} />);
    expect(
      screen.getByText(/No data source is connected for Task delivery/)
    ).toBeTruthy();
  });

  it("blames nobody where the measurement works and the person is absent", () => {
    render(
      <PersonCoverage unmeasured={[]} inactive={["Git output", "Wiki"]} />
    );
    expect(
      screen.getByText(/Nothing recorded in Git output and Wiki this period/)
    ).toBeTruthy();
    expect(screen.queryByText(/reaches us/)).toBeNull();
  });

  it("carries both reasons at once, each with its own sentence", () => {
    render(
      <PersonCoverage unmeasured={["Task delivery"]} inactive={["Wiki"]} />
    );
    expect(
      screen.getByText(/No data source is connected for Task delivery/)
    ).toBeTruthy();
    expect(screen.getByText(/Nothing recorded in Wiki/)).toBeTruthy();
  });
});
