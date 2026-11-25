import { describe, expect, it } from "vitest";

import {
  EDGE_SLACK_PX,
  GUTTER_PX,
  gutterState,
} from "@/components/widgets/metric-views/metric-timeseries-table-model";

const NONE = { start: false, end: false };
const BOTH = { start: true, end: true };

describe("gutterState", () => {
  it.each([
    {
      rule: "decides the gutters from the wrapper width, so a gutter cannot keep itself open",
      wrapper: 400,
      table: 400,
      scrollsDown: false,
      gutters: NONE,
    },
    {
      rule: "treats sub-pixel overflow as noise rather than a sideways scroll",
      wrapper: 400,
      table: 400 + EDGE_SLACK_PX,
      scrollsDown: false,
      gutters: NONE,
    },
    {
      rule: "gives a table wider than the wrapper both gutters",
      wrapper: 400,
      table: 400 + EDGE_SLACK_PX + 1,
      scrollsDown: false,
      gutters: BOTH,
    },
    {
      rule: "gives rows that scroll down the end gutter alone while the table fits beside it",
      wrapper: 400 + GUTTER_PX,
      table: 400,
      scrollsDown: true,
      gutters: { start: false, end: true },
    },
    {
      rule: "gives rows that scroll down both gutters once the table no longer fits beside the end one",
      wrapper: 400 + GUTTER_PX,
      table: 400 + EDGE_SLACK_PX + 1,
      scrollsDown: true,
      gutters: BOTH,
    },
  ])("$rule", ({ rule, wrapper, table, scrollsDown, gutters }) => {
    expect(
      gutterState(wrapper, table, scrollsDown),
      `should hold: ${rule}`
    ).toEqual(gutters);
  });
});
