// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  scrollEndIntoView,
  scrollEndOutOfView,
} from "@/test/intersection-observer";

import { useAutoLoadOnScroll } from "./use-auto-load-on-scroll";

interface Props {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

function harness(initialProps: Props = {
  hasNextPage: true,
  isFetchingNextPage: false,
}) {
  const fetchNextPage = vi.fn();
  const view = renderHook(
    (props: Props) => useAutoLoadOnScroll({ ...props, fetchNextPage }),
    { initialProps },
  );
  act(() => view.result.current(document.createElement("div")));
  return { ...view, fetchNextPage };
}

describe("useAutoLoadOnScroll", () => {
  it("asks for the next page when the end of the list comes into view", () => {
    const { fetchNextPage } = harness();

    act(scrollEndIntoView);

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("asks for nothing while the end is out of view", () => {
    const { fetchNextPage } = harness();

    act(scrollEndOutOfView);

    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it("keeps loading while the end stays in view", () => {
    const { rerender, fetchNextPage } = harness();

    act(scrollEndIntoView);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    act(() => rerender({ hasNextPage: true, isFetchingNextPage: true }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    act(() => rerender({ hasNextPage: true, isFetchingNextPage: false }));
    expect(fetchNextPage).toHaveBeenCalledTimes(2);

    act(() => rerender({ hasNextPage: true, isFetchingNextPage: true }));
    act(() => rerender({ hasNextPage: true, isFetchingNextPage: false }));
    expect(fetchNextPage).toHaveBeenCalledTimes(3);
  });

  it("stops the moment the listing says there is no next page", () => {
    const { rerender, fetchNextPage } = harness();

    act(scrollEndIntoView);
    act(() => rerender({ hasNextPage: true, isFetchingNextPage: true }));
    act(() => rerender({ hasNextPage: false, isFetchingNextPage: false }));

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("follows the marker to a new element", () => {
    const { result, fetchNextPage } = harness();

    act(scrollEndIntoView);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    act(() => result.current(document.createElement("div")));

    expect(fetchNextPage).toHaveBeenCalledTimes(2);
  });
});
