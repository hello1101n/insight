import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";

import { IcNeedsAttention } from "@/components/widgets/dashboard/ic-needs-attention";
import type { AttentionItem } from "@/lib/insight/attention";
import { AppTooltips, openTooltip } from "@/test/tooltip";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    key: "ai.active_days",
    group: "ai_adoption",
    label: "Active AI days",
    valueText: "2 days",
    valueNumber: "2",
    valueUnit: "days",
    medianText: "11 days",
    gapText: "-82%",
    spreadGap: 0.8,
    relGap: 0.8,
    kind: "fell" as const,
    direction: "higher_is_better",
    noPrevious: false,
    ...overrides,
  };
}

describe("IcNeedsAttention", () => {
  it("renders nothing without items", () => {
    const { container } = render(
      <IcNeedsAttention items={[]} onOpenGroup={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("titles the list as worth a look", () => {
    render(<IcNeedsAttention items={[item()]} onOpenGroup={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Worth a look" })
    ).toBeInTheDocument();
  });

  it("renders items in the order it is given", () => {
    // Ranking moved to `orderAttentionItems`, next to the rule that produced
    // the items: which of two findings is the stronger is a question about
    // the findings, and the thinning that follows depends on the answer.
    render(
      <IcNeedsAttention
        items={[
          item({ key: "b", label: "Large gap", relGap: 2.5 }),
          item({ key: "a", label: "Small gap", relGap: 0.1 }),
        ]}
        onOpenGroup={vi.fn()}
      />
    );
    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveTextContent("Large gap");
    expect(rows[1]).toHaveTextContent("Small gap");
  });

  it("shows the divergence gap next to the median", () => {
    render(
      <IcNeedsAttention
        items={[item({ gapText: "-82%", medianText: "11 days" })]}
        onOpenGroup={vi.fn()}
      />
    );
    const row = screen.getByRole("button");
    expect(row).toHaveTextContent("-82%");
    expect(row).toHaveTextContent("vs median 11 days");
  });

  it("routes clicks to the owning group", async () => {
    const onOpenGroup = vi.fn();
    render(
      <IcNeedsAttention
        items={[item({ group: "git_output" })]}
        onOpenGroup={onOpenGroup}
      />
    );
    await userEvent.click(screen.getByText("Active AI days"));
    expect(onOpenGroup).toHaveBeenCalledWith("git_output");
  });

  it("collapses beyond the threshold with a show-more toggle", () => {
    const items = Array.from({ length: 9 }, (_, i) =>
      item({ key: `m${i}`, label: `Metric ${i}`, relGap: i })
    );
    render(<IcNeedsAttention items={items} onOpenGroup={vi.fn()} />);
    expect(screen.getByText("Show 3 more")).toBeInTheDocument();
  });

  it.each([
    {
      over: { kind: "fell", direction: "lower_is_better" },
      badge: "rose this period",
    },
    {
      over: { kind: "fell", direction: "higher_is_better" },
      badge: "dropped this period",
    },
    {
      over: { kind: "behind", noPrevious: true },
      badge: "no earlier period to compare",
    },
    {
      over: { kind: "behind", noPrevious: false },
      badge: "not new this period",
    },
  ] satisfies Array<{ over: Partial<AttentionItem>; badge: string }>)(
    "names an adverse move by the way it went: $badge",
    ({ over, badge }) => {
      render(<IcNeedsAttention items={[item(over)]} onOpenGroup={vi.fn()} />);
      expect(
        screen.getByRole("button"),
        `${JSON.stringify(over)} should read "${badge}"`
      ).toHaveTextContent(badge);
    }
  );

  it("titles the row's name it may cut with the full name and opens no tooltip on it", async () => {
    render(
      <IcNeedsAttention
        items={[item({ label: "Messages per Active Collaboration Day" })]}
        onOpenGroup={vi.fn()}
      />,
      { wrapper: AppTooltips },
    );
    const name = screen.getByText("Messages per Active Collaboration Day");
    expect(name).toHaveAttribute(
      "title",
      "Messages per Active Collaboration Day"
    );

    await userEvent.hover(name);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(openTooltip()).toBeNull();
  });
});
