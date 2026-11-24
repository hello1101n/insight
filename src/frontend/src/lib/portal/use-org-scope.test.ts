import { describe, expect, it } from "vitest";

import type { PeopleListItem } from "@/api/identity-client";
import type { IdentityPerson } from "@/types/insight";
import { flatOrgScope, resolveScopeRoster } from "./use-org-scope";

const person = (
  personId: string,
  name: string,
  subordinates: IdentityPerson[] = [],
): IdentityPerson =>
  ({
    person_id: personId,
    email: `${name.toLowerCase().replace(/ /g, ".")}@x`,
    display_name: name,
    subordinates,
  }) as unknown as IdentityPerson;

const rosterPerson = (
  personId: string,
  displayName: string,
  over: Partial<PeopleListItem> = {},
): PeopleListItem => ({
  person_id: personId,
  display_name: displayName,
  first_name: null,
  last_name: null,
  username: null,
  email: null,
  attributes: {},
  manager_person_id: null,
  manager_name: null,
  ...over,
});

const TREE = person("p-ao", "Ao", [
  person("p-lead1", "Lead One", [
    person("p-ic1", "IC One"),
    person("p-lead2", "Lead Two", [person("p-ic2", "IC Two")]),
  ]),
  person("p-ic3", "IC Three"),
]);

describe("resolveScopeRoster", () => {
  it("defaults to the viewer's whole subtree", () => {
    const s = resolveScopeRoster(TREE, "p-ao", { root: null, directOnly: false });
    expect(s.label).toBe("Ao");
    expect(s.rosterCount).toBe(5);
    expect(s.scopeMemberCount).toBe(6);
  });
  it("scopes to a sub-lead's subtree", () => {
    const s = resolveScopeRoster(TREE, "p-ao", { root: "p-lead1", directOnly: false });
    expect(s.label).toBe("Lead One");
    expect(s.roster?.map((r) => r.person_id).sort()).toEqual([
      "p-ic1",
      "p-ic2",
      "p-lead2",
    ]);
  });
  it("narrows to direct reports", () => {
    const s = resolveScopeRoster(TREE, "p-ao", { root: "p-lead1", directOnly: true });
    expect(s.roster?.map((r) => r.person_id).sort()).toEqual(["p-ic1", "p-lead2"]);
    expect(s.roster?.map((person) => person.person_id).sort()).toEqual([
      "p-ic1",
      "p-lead2",
    ]);
    expect(s.rosterCount).toBe(2);
    expect(s.scopeMemberCount).toBe(3);
  });
  it("falls back to the viewer when root is outside the tree", () => {
    const s = resolveScopeRoster(TREE, "p-ao", { root: "p-stranger", directOnly: false });
    expect(s.label).toBe("Ao");
  });
  it("does not resolve a root outside the VIEWER's own subtree", () => {
    const s = resolveScopeRoster(TREE, "p-lead2", { root: "p-lead1", directOnly: false });
    expect(s.label).toBe("Lead Two");
  });
  it("directOnly is a no-op when the pivot has no indirect reports", () => {
    const s = resolveScopeRoster(TREE, "p-ao", { root: "p-lead2", directOnly: true });
    expect(s.roster?.map((r) => r.person_id)).toEqual(["p-ic2"]);
    expect(s.canDirectOnly).toBe(false);
  });
  it("lists manager nodes for the picker, depth-annotated", () => {
    const s = resolveScopeRoster(TREE, "p-ao", { root: null, directOnly: false });
    expect(s.managerNodes.map((m) => `${"·".repeat(m.depth)}${m.person_id}`)).toEqual([
      "p-ao",
      "·p-lead1",
      "··p-lead2",
    ]);
    expect(s.managerNodes.map((m) => m.subtreeMemberCount)).toEqual([6, 4, 2]);
    expect(s.managerNodes.map((m) => m.directMemberCount)).toEqual([3, 3, 2]);
  });

  it("keeps the picker in outline order across branches, not by depth", () => {
    const tree = person("p-top", "Top", [
      person("p-l1", "Lead 1", [person("p-l1a", "Lead 1A", [person("p-x", "X")])]),
      person("p-l2", "Lead 2", [person("p-l2a", "Lead 2A", [person("p-y", "Y")])]),
    ]);
    const s = resolveScopeRoster(tree, "p-top", { root: null, directOnly: false });
    expect(s.managerNodes.map((m) => m.person_id)).toEqual([
      "p-top",
      "p-l1",
      "p-l1a",
      "p-l2",
      "p-l2a",
    ]);
    expect(s.managerNodes.map((m) => m.subtreeMemberCount)).toEqual([
      7, 3, 2, 3, 2,
    ]);
    expect(s.managerNodes.map((m) => m.directMemberCount)).toEqual([
      3, 2, 2, 2, 2,
    ]);
  });
});

describe("flatOrgScope", () => {
  const roster = [
    rosterPerson("p-me", "Me"),
    rosterPerson("p-b", "Bea"),
    rosterPerson("p-c", "Cyd"),
  ];

  it("counts everyone the viewer may see, the viewer included", () => {
    const scope = flatOrgScope(roster);

    expect(scope.roster?.map((r) => r.person_id)).toEqual(["p-me", "p-b", "p-c"]);
    expect(scope.rosterCount).toBe(3);
    expect(scope.scopeMemberCount).toBe(3);
  });

  it("offers no manager nodes and no direct-only cut", () => {
    const scope = flatOrgScope(roster);

    expect(scope.managerNodes).toEqual([]);
    expect(scope.canDirectOnly).toBe(false);
  });

  it("names the organisation rather than a person", () => {
    const scope = flatOrgScope(roster);

    expect(scope.label).toBe("Whole organisation");
  });

  it("carries every naming field a person label reads (#2711)", () => {
    const scope = flatOrgScope([
      rosterPerson("p-h", "", { username: "handle", email: "" }),
    ]);

    expect(scope.roster).toEqual([
      {
        person_id: "p-h",
        display_name: "",
        username: "handle",
        email: "",
        supervisor_person_id: null,
        is_direct: false,
      },
    ]);
  });

  it("carries visible people without creating a report-specific profile", () => {
    const scope = flatOrgScope([
      rosterPerson("p-h", "Handle", {
        email: "handle@example.com",
        attributes: { job_title: "Engineer", status: "active" },
      }),
    ]);

    expect(scope.roster?.map((person) => person.person_id)).toEqual(["p-h"]);
  });


  it("has no roster before the answer arrives", () => {
    const scope = flatOrgScope(null);

    expect(scope.roster).toBeNull();
    expect(scope.rosterCount).toBe(0);
    expect(scope.scopeMemberCount).toBe(0);
  });
});
