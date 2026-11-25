// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/portal/portal-nav", () => ({
  usePortalNavActions: () => ({ setSlice: vi.fn() }),
  usePortalSlice: () => "",
}));

import { SliceSelect } from "./slice-select";

describe("SliceSelect", () => {
  it("does not offer a choice when the roster supports none", () => {
    render(<SliceSelect dims={[]} />);
    const trigger = screen.getByLabelText("Cohort");
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute(
      "title",
      expect.stringContaining("organization unit"),
    );
  });

  it("is a live control as soon as the roster supports one dimension", () => {
    render(<SliceSelect dims={[{ key: "division", label: "Division" }]} />);
    const trigger = screen.getByLabelText("Cohort");
    expect(trigger).not.toBeDisabled();
    expect(trigger).not.toHaveAttribute("title");
  });
});
