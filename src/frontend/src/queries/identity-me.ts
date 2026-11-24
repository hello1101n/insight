import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import {
  getMe,
  type MeResponse,
  type VisibilityPolicy,
} from "@/api/identity-client";
import { useAuth } from "@/auth/use-auth";
import { sessionAuthorizationScope } from "@/auth/session-scope";

export const ADMIN_ROLE_ID = "a4d11000-0000-4000-8000-000000000001";

const ME_STALE_TIME = 60 * 1000;

const ME_ERROR_RETRY_MS = 30 * 1000;

export function useMe(): UseQueryResult<MeResponse> {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  return useQuery({
    queryKey: ["identity", "me", sessionScope],
    queryFn: getMe,
    staleTime: ME_STALE_TIME,
    enabled: sessionScope != null,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: (query) =>
      query.state.status === "error" ? ME_ERROR_RETRY_MS : false,
  });
}

export interface AdminGate {
  isAdmin: boolean;
  isPending: boolean;
  isError: boolean;
  retry: () => void;
}

export function useIsAdmin(): AdminGate {
  const me = useMe();
  return {
    isAdmin:
      me.data?.roles.some((role) => role.role_id === ADMIN_ROLE_ID) ?? false,
    isPending: me.isPending,
    isError: me.isError,
    retry: () => void me.refetch(),
  };
}

export interface VisibilityPolicyState {
  policy: VisibilityPolicy;
  isFlat: boolean;
  isPending: boolean;
}

export function useVisibilityPolicy(): VisibilityPolicyState {
  const me = useMe();
  const policy: VisibilityPolicy = me.data?.visibility_policy ?? "org_chart";
  return { policy, isFlat: policy === "flat", isPending: me.isPending };
}
