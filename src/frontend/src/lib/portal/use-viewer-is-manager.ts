import { useViewer } from "@/auth";
import { useVisibleRoster } from "@/queries/visible-roster";

export function useViewerIsManager(): {
  isManager: boolean;
  isPending: boolean;
  isError: boolean;
} {
  const { personId } = useViewer();
  const roster = useVisibleRoster(true);
  const viewerId = personId?.toLowerCase();
  const isManager = viewerId
    ? roster.roster.some(
        (person) => person.manager_person_id?.toLowerCase() === viewerId,
      )
    : false;

  return {
    isManager,
    isPending: roster.isPending || roster.isError,
    isError: roster.isError,
  };
}
