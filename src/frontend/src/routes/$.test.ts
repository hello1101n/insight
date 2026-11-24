vi.mock("@tanstack/react-router", () => ({
  redirect: vi.fn((options: unknown) => ({ redirect: options })),
  createFileRoute: () => (options: Record<string, unknown>) => options,
}));

import { describe, expect, it, vi } from "vitest";

import { Route } from "./$";

const route = Route as unknown as { beforeLoad: () => void };

function thrownByBeforeLoad(): unknown {
  try {
    route.beforeLoad();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("/$", () => {
  it("sends an unmatched address to the default page", () => {
    expect(thrownByBeforeLoad()).toEqual({ redirect: { to: "/" } });
  });
});
