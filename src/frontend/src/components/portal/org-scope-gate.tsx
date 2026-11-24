/* eslint-disable react-refresh/only-export-components -- a render helper the org views call, not a mounted component. */
import type { ReactNode } from "react";

import { CenteredSpinner } from "@/components/widgets/centered-spinner";
import { ComingSoon } from "@/components/widgets/coming-soon";

export interface OrgScopeGateArgs {
  "data-testid"?: string;
  // WORKAROUND: TanStack Query reports a disabled query as pending forever, so callers pass `isLoading`.
  viewerLoading: boolean;
  viewerError: boolean;
  membersLoading: boolean;
  membersError: boolean;
  memberCount: number;
  gridPending: boolean;
  gridError: boolean;
  emptyLabel: string;
  onRetry: () => void;
}

export function orgScopeGate(a: OrgScopeGateArgs): ReactNode | null {
  if (a.viewerLoading || a.membersLoading)
    return <CenteredSpinner data-testid={a["data-testid"]} className="min-h-[60vh]" />;
  if (a.viewerError || a.membersError) return <GateCard data-testid={a["data-testid"]} error onRetry={a.onRetry} />;
  if (a.memberCount === 0) return <GateCard data-testid={a["data-testid"]} label={a.emptyLabel} />;
  if (a.gridPending) return <CenteredSpinner data-testid={a["data-testid"]} className="min-h-[60vh]" />;
  if (a.gridError) return <GateCard data-testid={a["data-testid"]} error onRetry={a.onRetry} />;
  return null;
}

function GateCard({
  "data-testid": testId,
  error,
  label,
  onRetry,
}: {
  "data-testid"?: string;
  error?: boolean;
  label?: string;
  onRetry?: () => void;
}) {
  return (
    <div data-testid={testId} className="mx-auto w-full max-w-md p-8">
      <ComingSoon
        variant="card"
        state={error ? "error" : "empty"}
        label={label}
        onRetry={onRetry}
      />
    </div>
  );
}
