// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PeerMark } from "@/components/widgets/metric-views/peer-mark";
import type { PeerStanding } from "@/lib/metrics/peer-standing";
import type { PeerStatusWithNeutral } from "@/lib/peers";

function standing(
  overrides: Partial<PeerStanding> & { gapDelta?: number } = {}
): PeerStanding {
  return {
    observed: true,
    stats: { p25: 8, p50: 10, p75: 12, min: 0, max: 30, n: 20 },
    eligible: true,
    reason: "ok",
    rank: "in_pack" as PeerStatusWithNeutral,
    gapDelta: 0,
    gapPct: 0,
    severity: 0,
    spreadGap: 0,
    ...overrides,
  } as PeerStanding;
}

function draw(s: PeerStanding) {
  const { container } = render(
    <PeerMark standing={s} metricLabel="Commits" format="integer" />
  );
  return {
    dot: container.querySelector("circle"),
    pin: container.querySelector("path"),
    svg: container.querySelector('[data-slot="peer-mark"]'),
    label: container
      .querySelector('[data-slot="peer-mark"]')
      ?.getAttribute("aria-label"),
  };
}

describe("PeerMark", () => {
  it("puts a reading at the group's middle on the shared line", () => {
    const { dot } = draw(standing({ gapDelta: 0 }));
    expect(Number(dot?.getAttribute("cx"))).toBe(56);
  });

  it("measures distance in spreads, not in the metric's own units", () => {
    const { dot, label } = draw(standing({ gapDelta: 4 }));
    expect(label).toMatch(/1\.0 spreads above/);
    expect(Number(dot?.getAttribute("cx"))).toBeCloseTo(76.4, 1);
  });

  it("draws no mark where there is nothing to compare against", () => {
    const { dot, pin, svg } = draw(
      standing({ eligible: false, rank: "neutral", gapDelta: 3 })
    );
    expect(svg).not.toBeNull();
    expect(dot).toBeNull();
    expect(pin).toBeNull();
  });

  it("pins an extreme reading instead of letting it set the scale", () => {
    const { dot, pin, label } = draw(standing({ gapDelta: 44 }));
    expect(dot).toBeNull();
    expect(pin).not.toBeNull();
    expect(label).toMatch(/11\.0 spreads above/);
  });

  it("colours only what the shared standing calls bottom of the pack", () => {
    const far = draw(standing({ gapDelta: 8, rank: "top" }));
    expect(far.dot?.getAttribute("class")).not.toMatch(/destructive/);

    const adverse = draw(standing({ gapDelta: -8, rank: "bottom" }));
    expect(adverse.dot?.getAttribute("class")).toMatch(/destructive/);
  });
});
