import { describe, expect, it } from "vitest";

import type { MetricDefinitionListResponse } from "@/api/metric-definitions-client";
import type { SliceAttr } from "@/lib/insight/slices";
import { catalogAttributes, cohortOptions } from "./cohort-options";

const person = (division: string): Record<string, SliceAttr> => ({
  division: { key: "division", label: "Division", value: division },
});

const response = (extra: object = {}): MetricDefinitionListResponse =>
  ({ metrics: [], ...extra }) as MetricDefinitionListResponse;

describe("catalogAttributes", () => {
  it("reads the attributes a response carries", () => {
    expect(
      catalogAttributes(
        response({
          comparison_attributes: [
            { id: "job_title", label: "Title" },
            { id: "division", label: "Division" },
          ],
        }),
      ),
    ).toEqual([
      { id: "job_title", label: "Title" },
      { id: "division", label: "Division" },
    ]);
  });

  it("treats a response without one as a normal state", () => {
    expect(catalogAttributes(response())).toEqual([]);
    expect(catalogAttributes(undefined)).toEqual([]);
  });

  it("drops entries it cannot render or send back", () => {
    expect(
      catalogAttributes(
        response({
          comparison_attributes: [
            { id: "ok", label: "Fine" },
            { id: "no_label" },
            { label: "no id" },
            null,
            "not an object",
          ],
        }),
      ),
    ).toEqual([{ id: "ok", label: "Fine" }]);
  });
});

describe("cohortOptions", () => {
  it("follows the catalog when there is one", () => {
    const options = cohortOptions(
      [{ id: "job_title", label: "Title" }],
      [person("Alpha"), person("Alpha"), person("Beta")],
    );
    expect(options.source).toBe("catalog");
    expect(options.dims).toEqual([{ key: "job_title", label: "Title" }]);
  });

  it("does not mix the two sources", () => {
    const options = cohortOptions(
      [{ id: "job_title", label: "Title" }],
      [person("Alpha"), person("Alpha"), person("Beta")],
    );
    expect(options.dims.map((d) => d.key)).not.toContain("division");
  });

  it("falls back to the roster until the catalog exists", () => {
    const options = cohortOptions(
      [],
      [person("Alpha"), person("Alpha"), person("Beta")],
    );
    expect(options.source).toBe("roster");
    expect(options.dims.map((d) => d.key)).toEqual(["division"]);
  });

  it("reports having nothing when neither source can offer anything", () => {
    const options = cohortOptions([], [person("Alpha")]);
    expect(options.source).toBe("none");
    expect(options.dims).toEqual([]);
  });
});
