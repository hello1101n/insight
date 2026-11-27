// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import "@/i18n";
import type { PersonSummary } from "@/api/identity-client";

import { personDisplayName } from "@/lib/identities/person-display";

import { PersonCell } from "./person-cell";

function person(over: Partial<PersonSummary>): PersonSummary {
  return { person_id: "01900000-0000-7000-8000-000000000001", ...over };
}

describe("personDisplayName", () => {
  it.each<[string, Partial<PersonSummary>, string]>([
    ["display name first", { display_name: "Ann Lee", email: "a@example.com" }, "Ann Lee"],
    ["the handle over the address", { email: "a@example.com", username: "alee" }, "alee"],
    ["the address when there is no handle", { email: "a@example.com" }, "a@example.com"],
    ["the id when nothing else exists", {}, "01900000-0000-7000-8000-000000000001"],
  ])("picks %s", (_name, fields, expected) => {
    expect(personDisplayName(person(fields))).toBe(expected);
  });
});

describe("PersonCell", () => {
  it("identifies without repeating: the name field is skipped in the detail line", () => {
    render(
      <PersonCell
        person={person({ email: "a@example.com", job_title: "Engineer" })}
      />,
    );

    expect(screen.getByText("a@example.com")).toBeInTheDocument();
    expect(screen.getByText("Engineer")).toBeInTheDocument();
    expect(screen.queryAllByText(/a@example\.com/)).toHaveLength(1);
  });

  it("always shows the person id, and offers it for copying", () => {
    render(<PersonCell person={person({ display_name: "Ann Lee" })} />);

    expect(
      screen.getByText("01900000-0000-7000-8000-000000000001"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /copy 01900000-0000-7000-8000-000000000001/i,
      }),
    ).toBeInTheDocument();
  });

  it("reads an attribute-less person as unnamed rather than naming it by its id", () => {
    render(<PersonCell person={person({})} />);

    expect(screen.getByText(/unnamed person/i)).toBeInTheDocument();
    expect(
      screen.getAllByText("01900000-0000-7000-8000-000000000001"),
    ).toHaveLength(1);
  });

  it("marks a person the journal knows only from an automatic mint", async () => {
    render(
      <PersonCell person={person({ display_name: "New Joiner", provisional: true })} />,
    );

    const badge = screen.getByText(/^provisional$/i);
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("tabindex", "0");

    await userEvent.hover(badge);
    expect(
      await screen.findByText(/created by automation, not confirmed/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/first sign-in/i)).not.toBeInTheDocument();
  });

  it("marks a terminated person", () => {
    render(
      <PersonCell
        person={person({ display_name: "Gone Person", status: "terminated" })}
      />,
    );

    expect(screen.getByText(/terminated/i)).toBeInTheDocument();
  });

  it("does not mark an active person", () => {
    render(
      <PersonCell person={person({ display_name: "Here Person", status: "active" })} />,
    );

    expect(screen.queryByText(/terminated/i)).not.toBeInTheDocument();
  });
});
