import { useViewerIsManager } from "@/lib/portal/use-viewer-is-manager";
import { useVisibilityPolicy } from "@/queries/identity-me";

export interface ViewerReach {
  canSeeOthers: boolean;
  isManager: boolean;
  isPending: boolean;
  isError: boolean;
}

export function useViewerReach(): ViewerReach {
  const {
    isManager,
    isPending: treePending,
    isError: treeError,
  } = useViewerIsManager();
  const policy = useVisibilityPolicy();

  return {
    canSeeOthers: policy.isFlat || isManager,
    isManager,
    isPending: treePending || policy.isPending,
    isError: treeError,
  };
}
