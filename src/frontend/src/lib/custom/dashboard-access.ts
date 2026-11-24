import type {
  DashboardAccess,
  FolderAccess,
  FolderSummary,
} from "@/api/custom-client";

export interface DashboardAllows {
  edit: boolean;
  share: boolean;
  remove: boolean;
}

export function dashboardAllows(access: DashboardAccess): DashboardAllows {
  switch (access) {
    case "owner":
      return { edit: true, share: true, remove: true };
    case "editor":
      return { edit: true, share: true, remove: false };
    case "ownerless":
      return { edit: true, share: false, remove: true };
    case "viewer":
      return { edit: false, share: false, remove: false };
  }
}

export interface FolderAllows {
  edit: boolean;
  share: boolean;
  remove: boolean;
}

export function folderAllows(
  access: FolderAccess,
  isAdmin: boolean
): FolderAllows {
  switch (access) {
    case "owner":
      return { edit: true, share: isAdmin, remove: true };
    case "editor":
      return { edit: true, share: isAdmin, remove: false };
    case "ownerless":
      return { edit: true, share: false, remove: true };
    case "viewer":
      return { edit: false, share: false, remove: false };
  }
}

export function fileableFolders(
  access: DashboardAccess,
  folders: readonly FolderSummary[],
  holding: readonly { id: string }[]
): FolderSummary[] {
  const ownerless = access === "ownerless";
  const held = new Set(holding.map((folder) => folder.id));

  return folders.filter(
    (folder) =>
      folderAllows(folder.access, true).edit &&
      (folder.access === "ownerless") === ownerless &&
      !held.has(folder.id)
  );
}
