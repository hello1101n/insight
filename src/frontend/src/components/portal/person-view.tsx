import { MetricGroupsView } from "@/components/portal/metric-groups-view";
import { PersonHeader } from "@/components/portal/person-header";
import { SingleGroupView } from "@/components/portal/single-group-view";
import { personDisplayName } from "@/lib/identities/person-display";
import { visibleGroups } from "@/lib/insight/groups";
import { usePageTitle } from "@/lib/portal/document-title-frame";
import { useGo } from "@/lib/portal/portal-nav";
import { usePortalShowPlanned } from "@/lib/portal/portal-store";
import { useIcPerson } from "@/queries/ic-dashboard";

export function PersonView({ person, section }: { person: string; section: string | null }) {
  const go = useGo();
  const showPlanned = usePortalShowPlanned();
  const groups = visibleGroups(showPlanned);
  const groupIds = groups.map((group) => group.id);
  const selectedSection = groups.find((group) => group.id === section)?.id ?? null;
  const record = useIcPerson(person);
  const name = record.data ? personDisplayName(record.data) : null;
  usePageTitle(name);

  return (
    <>
      <PersonHeader person={person} />
      {selectedSection ? (
        <SingleGroupView
          personId={person}
          groupId={selectedSection}
          data-testid={`page-person-${selectedSection.replaceAll("_", "-")}`}
        />
      ) : (
        <MetricGroupsView
          data-testid="page-person-at-a-glance"
          personId={person}
          groupIds={groupIds}
          content="glance"
          onSelectGroup={(id) => go({ zone: "person", person, section: id })}
        />
      )}
    </>
  );
}
