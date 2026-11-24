import { describe, expect, it } from "vitest";

import type { PersonalMetric } from "@/api/personal-metrics-client";
import {
  exclusiveEnd,
  isPersonalKey,
  personalDefinition,
  personalKey,
  personalResults,
} from "./personal-metrics";

const metric = (over: Partial<PersonalMetric> = {}): PersonalMetric => ({
  id: "focus-hours",
  label: "Focus hours",
  unit: "h",
  format: "duration",
  direction: "lower_is_better",
  description: "Hours without meetings",
  calculation: "sum",
  shared_by: { person_id: "p1", name: "Ada", at: "2026-01-02T03:04:05.000Z" },
  ...over,
});

describe("exclusiveEnd", () => {
  it("exclusiveEnd adds one day", () => {
    expect(exclusiveEnd({ from: "2026-01-29", to: "2026-01-31" })).toEqual({
      from: "2026-01-29",
      to: "2026-02-01",
    });
  });

  it("exclusiveEnd of a one-day range", () => {
    expect(exclusiveEnd({ from: "2026-03-10", to: "2026-03-10" })).toEqual({
      from: "2026-03-10",
      to: "2026-03-11",
    });
  });

  it("exclusiveEnd crosses a year end", () => {
    expect(exclusiveEnd({ from: "2025-12-01", to: "2025-12-31" }).to).toBe(
      "2026-01-01",
    );
  });

  it("exclusiveEnd crosses a DST change date", () => {
    expect(exclusiveEnd({ from: "2026-03-28", to: "2026-03-28" }).to).toBe(
      "2026-03-29",
    );
    expect(exclusiveEnd({ from: "2026-03-29", to: "2026-03-29" }).to).toBe(
      "2026-03-30",
    );
    expect(exclusiveEnd({ from: "2026-10-24", to: "2026-10-25" }).to).toBe(
      "2026-10-26",
    );
  });

  it("exclusiveEnd handles a leap day", () => {
    expect(exclusiveEnd({ from: "2028-02-28", to: "2028-02-28" }).to).toBe(
      "2028-02-29",
    );
    expect(exclusiveEnd({ from: "2028-02-29", to: "2028-02-29" }).to).toBe(
      "2028-03-01",
    );
  });
});

describe("personal keys", () => {
  it("personalKey prefixes the id and isPersonalKey recognises it", () => {
    expect(personalKey("abc")).toBe("personal.abc");
    expect(isPersonalKey("personal.abc")).toBe(true);
    expect(isPersonalKey("tasks_closed")).toBe(false);
  });
});

describe("personalResults", () => {
  const values = {
    values: [
      { metric: "a", person_id: "AAAA-1", value: 4 },
      { metric: "a", person_id: "BBBB-2", value: null },
      { metric: "b", person_id: "AAAA-1", value: 0 },
    ],
    teams: [],
  };

  it("personalResults keeps null values", () => {
    const out = personalResults(values, ["personal.a"]);
    expect(out.get("personal.a")?.period?.values).toEqual([
      { entity_id: "aaaa-1", value: 4 },
      { entity_id: "bbbb-2", value: null },
    ]);
  });

  it("personalResults keys by personal key and skips other metrics", () => {
    const out = personalResults(values, ["personal.a", "personal.b"]);
    expect([...out.keys()]).toEqual(["personal.a", "personal.b"]);
    expect(out.get("personal.b")?.period?.values[0]?.value).toBe(0);
  });

  it("personalResults gives a metric with no rows an empty period", () => {
    const out = personalResults(values, ["personal.c"]);
    expect(out.get("personal.c")?.period?.values).toEqual([]);
  });
});

describe("personalDefinition", () => {
  it("personalDefinition maps direction and unit", () => {
    const def = personalDefinition(metric());
    expect(def).toMatchObject({
      metric_key: "personal.focus-hours",
      origin: "custom",
      entity_type: "person",
      is_enabled: true,
      schema_status: "ok",
      last_observed_date: null,
      label: "Focus hours",
      unit: "h",
      direction: "lower_is_better",
      description: "Hours without meetings",
    });
    expect(def.drilldown).toBeUndefined();
  });

  it("personalDefinition maps formats", () => {
    expect(personalDefinition(metric({ format: "number" })).format).toBe("decimal");
    expect(personalDefinition(metric({ format: "percent" })).format).toBe("percent");
    expect(personalDefinition(metric({ format: "currency" })).format).toBe("currency");
    expect(personalDefinition(metric({ format: "duration" })).format).toBe("decimal");
  });

  it("personalDefinition keeps calculation and sharer reachable", () => {
    const def = personalDefinition(metric());
    expect(def.calculation).toBe("sum");
    expect(def.shared_by?.name).toBe("Ada");
    expect(personalDefinition(metric({ shared_by: null })).shared_by).toBeNull();
  });
});
