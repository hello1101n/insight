import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Choice, NumberInput } from "./condition-leaf";

const OPTIONS = [
  { value: ">", label: "greater than" },
  { value: "<", label: "less than" },
];

describe("Choice", () => {
  it.each([
    ["~=", ["~=", "greater than", "less than"]],
    [">", ["greater than", "less than"]],
    ["", ["greater than", "less than"]],
  ])(
    "offers a value the list does not hold as its own option, unchanged: %j",
    async (value, offered) => {
      const onChange = vi.fn();
      render(
        <Choice
          id="op"
          label="Operator"
          value={value}
          options={OPTIONS}
          onChange={onChange}
        />
      );

      await userEvent.click(screen.getByRole("combobox", { name: "Operator" }));
      const options = await screen.findAllByRole("option");

      expect(
        options.map((option) => option.textContent),
        `value: ${value}`
      ).toEqual(offered);
      expect(onChange).not.toHaveBeenCalled();
    }
  );
});

describe("NumberInput", () => {
  it("keeps '1.50' as typed while it still means 1.5", async () => {
    const field = (value: unknown) => (
      <NumberInput id="value" label="Value" value={value} onChange={vi.fn()} />
    );
    const { rerender } = render(field(1.5));
    const input = screen.getByLabelText("Value");

    await userEvent.type(input, "0");
    expect(input).toHaveValue("1.50");

    rerender(field(2));
    expect(input, "a value set elsewhere replaces the text").toHaveValue("2");
  });
});
