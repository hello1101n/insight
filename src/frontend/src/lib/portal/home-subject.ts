import { OWN_OVERVIEW_ITEMS } from "@/lib/portal/overview-configs";
import { useViewerReach } from "@/lib/portal/use-viewer-reach";

export type HomeSubject = "me" | "team";

export function homeSubject(canSeeOthers: boolean): HomeSubject {
  return canSeeOthers ? "team" : "me";
}

export function homeItemShown(subject: HomeSubject, item: string): boolean {
  return subject === "team" || item in OWN_OVERVIEW_ITEMS;
}

export function useHomeSubject(): {
  subject: HomeSubject;
  isPending: boolean;
} {
  const { canSeeOthers, isPending, isError } = useViewerReach();

  return {
    subject: homeSubject(canSeeOthers),
    isPending: isPending && !isError,
  };
}
