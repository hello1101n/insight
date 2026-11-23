// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n";
import type { PersonSearchResponse } from "@/api/identity-client";

const list = vi.hoisted(() => ({
  q: "",
  intent: "browse" as "browse" | "match",
  state: {
    data: undefined as { pages: PersonSearchResponse[] } | undefined,
    isFetching: false,
    isFetchingNextPage: false,
    isPlaceholderData: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  },
}));
vi.mock("@/queries/identity-resolution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/queries/identity-resolution")>()),
  usePersonList: (q: string, intent: "browse" | "match" = "browse") => {
    list.q = q;
    list.intent = intent;
    return list.state;
  },
}));
vi.mock("@/hooks/use-debounced-value", () => ({
  useDebouncedValue: <T,>(value: T) => value,
}));

import { SCROLL_ENDS_AFTER_ROWS } from "@/components/widgets/scroll-to-ends";
import { MAX_SEARCH_CHARS } from "@/queries/identity-resolution";
import { scrollEndIntoView } from "@/test/intersection-observer";

import { PersonPicker } from "./person-picker";

const BOB = {
  person_id: "01900000-0000-7000-8000-0000000000b0",
  display_name: "Bob Park",
  email: "bob.park@example.com",
};
const CAROL = {
  person_id: "01900000-0000-7000-8000-0000000000c0",
  display_name: "Carol Chen",
  email: "carol.chen@example.com",
};

function page(items: PersonSearchResponse["items"]): PersonSearchResponse {
  return { items };
}

beforeEach(() => {
  list.q = "";
  list.intent = "browse";
  list.state = {
    data: undefined,
    isFetching: false,
    isFetchingNextPage: false,
    isPlaceholderData: false,
    isError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
  };
});

describe("PersonPicker", () => {
  it("starts from the terms it was handed", () => {
    render(<PersonPicker onPick={vi.fn()} initialQuery="park" />);

    expect(screen.getByRole("searchbox")).toHaveValue("park");
  });

  it("reports the terms once the reader has stopped typing", async () => {
    const onSettled = vi.fn();
    render(<PersonPicker onPick={vi.fn()} onSettled={onSettled} />);

    await userEvent.type(screen.getByRole("searchbox"), "park");

    expect(onSettled).toHaveBeenLastCalledWith("park");
  });

  it("stops at the length the service accepts", () => {
    render(<PersonPicker onPick={vi.fn()} />);

    expect(screen.getByRole("searchbox")).toHaveAttribute(
      "maxlength",
      String(MAX_SEARCH_CHARS),
    );
  });

  it.each(["b", "bob p"])("searches as soon as %j is typed", async (typed) => {
    list.state.data = { pages: [page([BOB])] };
    render(<PersonPicker onPick={vi.fn()} />);

    await userEvent.type(screen.getByRole("searchbox"), typed);

    expect(screen.getByText("Bob Park")).toBeInTheDocument();
  });

  it("keeps the roster on an empty field where the caller asked for one", () => {
    list.state.data = { pages: [page([BOB])] };
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty />);

    expect(screen.getByText("Bob Park")).toBeInTheDocument();
  });

  it("offers only the persons the caller allows, whatever the case of their id", () => {
    list.state.data = { pages: [page([BOB, CAROL])] };
    render(
      <PersonPicker
        onPick={vi.fn()}
        browseWhenEmpty
        onlyIds={new Set([BOB.person_id.toLowerCase()])}
      />,
    );

    expect(screen.getByText("Bob Park")).toBeInTheDocument();
    expect(screen.queryByText("Carol Chen")).not.toBeInTheDocument();
  });

  it("matches an allowed id listed in capitals", () => {
    list.state.data = {
      pages: [page([{ ...BOB, person_id: BOB.person_id.toUpperCase() }])],
    };
    render(
      <PersonPicker
        onPick={vi.fn()}
        browseWhenEmpty
        onlyIds={new Set([BOB.person_id])}
      />,
    );

    expect(screen.getByText("Bob Park")).toBeInTheDocument();
  });

  it("hands the picked person to the caller and fires nothing else", async () => {
    list.state.data = { pages: [page([BOB])] };
    const onPick = vi.fn();
    render(<PersonPicker onPick={onPick} />);

    await userEvent.type(screen.getByRole("searchbox"), "bob");
    await userEvent.click(screen.getByRole("button", { name: /bob park/i }));

    expect(onPick).toHaveBeenCalledWith(BOB);
  });

  it("marks the list as busy while it answers the previous term", () => {
    list.state.data = { pages: [page([BOB])] };
    list.state.isPlaceholderData = true;
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty />);

    expect(screen.getByRole("list")).toHaveAttribute("aria-busy", "true");
  });

  it("still picks a row while the list is one term behind", async () => {
    list.state.data = { pages: [page([BOB])] };
    list.state.isPlaceholderData = true;
    const onPick = vi.fn();
    render(<PersonPicker onPick={onPick} browseWhenEmpty />);

    await userEvent.click(screen.getByRole("button", { name: /bob park/i }));

    expect(onPick).toHaveBeenCalledWith(BOB);
  });

  it("drops the busy mark once the rows answer the field", () => {
    list.state.data = { pages: [page([BOB])] };
    list.state.isPlaceholderData = false;
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty />);

    expect(screen.getByRole("list")).toHaveAttribute("aria-busy", "false");
  });

  it("does not repeat persons the panel already shows", async () => {
    list.state.data = { pages: [page([BOB, CAROL])] };
    render(<PersonPicker onPick={vi.fn()} excludeIds={[BOB.person_id]} />);

    await userEvent.type(screen.getByRole("searchbox"), "park");

    expect(screen.getByText("Carol Chen")).toBeInTheDocument();
    expect(screen.queryByText("Bob Park")).not.toBeInTheDocument();
  });

  it("shows every page fetched so far as one list", () => {
    list.state.data = { pages: [page([BOB]), page([CAROL])] };
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty />);

    expect(screen.getByText("Bob Park")).toBeInTheDocument();
    expect(screen.getByText("Carol Chen")).toBeInTheDocument();
  });

  it("asks for the next page when the end of the list comes into view", () => {
    list.state.data = { pages: [page([BOB])] };
    list.state.hasNextPage = true;
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty />);

    scrollEndIntoView();

    expect(list.state.fetchNextPage).toHaveBeenCalled();
  });

  it("asks once, not once per frame, while a page is already in flight", () => {
    list.state.data = { pages: [page([BOB])] };
    list.state.hasNextPage = true;
    list.state.isFetchingNextPage = true;
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty />);

    scrollEndIntoView();
    scrollEndIntoView();

    expect(list.state.fetchNextPage).not.toHaveBeenCalled();
  });

  it("still reaches the next page when every row of this one was excluded", () => {
    list.state.data = { pages: [page([BOB])] };
    list.state.hasNextPage = true;
    render(<PersonPicker onPick={vi.fn()} excludeIds={[BOB.person_id]} browseWhenEmpty />);

    scrollEndIntoView();

    expect(list.state.fetchNextPage).toHaveBeenCalled();
  });

  it("offers the jump-to-either-end control only on a long list", () => {
    const many = Array.from({ length: SCROLL_ENDS_AFTER_ROWS + 1 }, (_, i) => ({
      person_id: `01900000-0000-7000-8000-${String(i).padStart(12, "0")}`,
      display_name: `Person ${i}`,
    }));
    list.state.data = { pages: [page([BOB])] };
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty asSurface />);
    expect(
      screen.queryByRole("button", { name: /back to the top/i }),
    ).not.toBeInTheDocument();

    list.state.data = { pages: [page(many)] };
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty asSurface />);

    expect(
      screen.getAllByRole("button", { name: /back to the top/i }),
    ).not.toHaveLength(0);
    expect(
      screen.getAllByRole("button", { name: /jump to the end/i }),
    ).not.toHaveLength(0);
  });

  it("stays a plain short list inside a panel", () => {
    list.state.data = { pages: [page([BOB])] };
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty />);

    expect(
      screen.queryByRole("button", { name: /back to the top/i }),
    ).not.toBeInTheDocument();
  });

  it("stops asking once the listing says there is no next page", () => {
    list.state.data = { pages: [page([BOB])] };
    list.state.hasNextPage = false;
    render(<PersonPicker onPick={vi.fn()} browseWhenEmpty />);

    scrollEndIntoView();

    expect(list.state.fetchNextPage).not.toHaveBeenCalled();
  });

  it.each([
    ["the dialog's field", false, "match" as const],
    ["the console's own mode", true, "browse" as const],
  ])(
    "tells the listing what an empty field means in %s",
    (_case, browseWhenEmpty, expected) => {
      render(
        <PersonPicker onPick={vi.fn()} browseWhenEmpty={browseWhenEmpty} />,
      );

      expect(list.intent).toBe(expected);
    },
  );

  it("shows nothing where an empty field means matches, even with rows in hand", () => {
    list.state.data = { pages: [page([BOB, CAROL])] };
    list.state.hasNextPage = true;

    render(<PersonPicker onPick={vi.fn()} />);

    expect(screen.queryByText("Bob Park")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show more/i }),
    ).not.toBeInTheDocument();
  });

  it("still searches once terms are typed into that same field", async () => {
    list.state.data = { pages: [page([BOB])] };
    render(<PersonPicker onPick={vi.fn()} />);

    await userEvent.type(screen.getByRole("searchbox"), "iva example");

    expect(list.q).toBe("iva example");
    expect(list.intent).toBe("match");
    expect(screen.getByText("Bob Park")).toBeInTheDocument();
  });

  it("offers the next page instead of claiming nobody matches", async () => {
    list.state.data = { pages: [page([BOB])] };
    list.state.hasNextPage = true;
    render(<PersonPicker onPick={vi.fn()} excludeIds={[BOB.person_id]} />);

    await userEvent.type(screen.getByRole("searchbox"), "park");

    expect(screen.queryByText(/nobody matches/i)).not.toBeInTheDocument();
    scrollEndIntoView();
    expect(list.state.fetchNextPage).toHaveBeenCalled();
  });
});
