import type { Meta, StoryObj } from "@storybook/react-vite";
import { delay, http } from "msw";

import { GroupDrilldownSheet } from "@/components/widgets/dashboard/group-drilldown-sheet";
import { GROUPS, type GroupId } from "@/lib/insight/groups";
import { handlers } from "@/mocks/handlers";
import { PEOPLE } from "@/mocks/registry";
import { useMetricCollection } from "@/queries/metric-results";

const RANGE = { from: "2026-10-01", to: "2026-10-31" };
const COMPARE_TO = { from: "2026-09-01", to: "2026-09-30" };
const PERSON = PEOPLE[0]!.person_id;
const TEAM = PEOPLE.slice(0, 4).map((person) => ({
  entityId: person.person_id,
  displayName: person.name,
}));

function Sheet({ group, team }: { group: GroupId; team: boolean }) {
  const def = GROUPS.find((candidate) => candidate.id === group)!;
  const data = useMetricCollection(
    def.collection,
    { type: "person", ids: team ? [] : [PERSON] },
    RANGE
  );

  return (
    <GroupDrilldownSheet
      open
      onOpenChange={() => {}}
      def={def}
      metricTarget={
        team
          ? { kind: "team", members: TEAM }
          : { kind: "person", entityId: PERSON, data }
      }
      range={RANGE}
      compareTo={COMPARE_TO}
    />
  );
}

const meta: Meta<typeof Sheet> = {
  title: "Widgets/Dashboard/GroupDrilldownSheet",
  component: Sheet,
  args: { group: "git_output", team: false },
  parameters: { layout: "fullscreen", msw: { handlers } },
};
export default meta;

type Story = StoryObj<typeof Sheet>;

export const Person: Story = {};

export const Team: Story = { args: { team: true } };

export const TeamLoading: Story = {
  args: { team: true },
  parameters: {
    msw: {
      handlers: [
        http.post("*/api/analytics/v1/metric-results", async () => {
          await delay("infinite");
        }),
        ...handlers,
      ],
    },
  },
};
