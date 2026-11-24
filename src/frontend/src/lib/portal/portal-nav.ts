import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { normalizePersonId } from "@/lib/metrics/entity";
import { type OrgScope, usePortalShowPlanned } from "@/lib/portal/portal-store";
import { linkTo, type NavTarget } from "@/lib/portal/portal-routes";
import { usePortalSearch, useSetPortalSearch } from "@/lib/portal/portal-search";
import { useNavLocation } from "@/lib/portal/use-nav-location";
import { recordUsageEvent, scopeLabel } from "@/telemetry";

export function usePortalSlice(): string {
  const slice = usePortalSearch().slice ?? "";
  return usePortalShowPlanned() ? slice : "";
}

export function usePortalScope(): OrgScope {
  const { scope, direct } = usePortalSearch();
  return useMemo(
    () => ({ root: scope ?? null, directOnly: direct ?? false }),
    [scope, direct],
  );
}

export function useGo(): (target: NavTarget, opts?: { replace?: boolean }) => void {
  const navigate = useNavigate();
  return useCallback(
    (target, opts) => {
      void navigate({ ...linkTo(target), replace: opts?.replace ?? false });
    },
    [navigate],
  );
}

export interface PortalNavActions {
  setItem: (item: string | null) => void;
  openItem: (zone: "overview" | "aicost" | "reports" | "manage", item: string) => void;
  setAcct: (acct: string | null) => void;
  openDirection: (dir: string, lens?: string) => void;
  openRepository: (repo: string) => void;
  setSlice: (slice: string) => void;
  setScope: (patch: Partial<OrgScope>) => void;
  replaceScope: (patch: Partial<OrgScope>) => void;
}

export function usePortalNavActions(): PortalNavActions {
  const setSearch = useSetPortalSearch();
  const go = useGo();
  const { zone, person } = useNavLocation();

  return useMemo(
    () => ({
      setItem: (item) => {
        const picked = item ?? undefined;
        if (zone === "person") go({ zone, person, section: picked });
        else if (zone === "people") go({ zone, person, item: picked });
        else if (zone === "overview" || zone === "aicost" || zone === "reports" || zone === "manage") {
          go({ zone, item: picked });
        }
      },
      openItem: (target, item) => go({ zone: target, item }),
      setAcct: (acct) => setSearch({ acct: acct ?? undefined }),
      openDirection: (dir, lens) => go({ zone: "directions", dir: dir || undefined, lens }),
      openRepository: (repo) => setSearch({ repo: repo || undefined }),
      setSlice: (slice) => {
        recordUsageEvent("cohort", slice || "none");
        setSearch({ slice: slice || undefined });
      },
      replaceScope: (patch) =>
        setSearch(
          { ...("root" in patch ? { scope: patch.root ?? undefined } : {}) },
          { replace: true },
        ),
      setScope: (patch) => {
        recordUsageEvent(
          "scope",
          scopeLabel({
            root: patch.root ?? null,
            directOnly: patch.directOnly ?? false,
            attrFilter: patch.attrFilter,
          }),
        );
        return setSearch((prev) => ({
          ...("root" in patch ? { scope: patch.root ?? undefined } : {}),
          ...("directOnly" in patch ? { direct: patch.directOnly } : {}),
          ...("root" in patch &&
          !("directOnly" in patch) &&
          normalizePersonId(patch.root ?? "") !== normalizePersonId(prev.scope ?? "")
            ? { direct: undefined }
            : {}),
        }));
      },
    }),
    [setSearch, go, zone, person],
  );
}
