import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import {
  createApiToken,
  listApiTokens,
  removeApiToken,
  type ApiTokenList,
  type ApiTokenRequest,
} from "@/api/api-tokens-client";
import { sessionAuthorizationScope } from "@/auth/session-scope";
import { useAuth } from "@/auth/use-auth";

const LIST_KEY = ["api-tokens", "list"] as const;

export function useApiTokens(): UseQueryResult<ApiTokenList> {
  const { session } = useAuth();
  return useQuery({
    queryKey: [...LIST_KEY, sessionAuthorizationScope(session)],
    queryFn: listApiTokens,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useCreateApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ApiTokenRequest) => createApiToken(body),
    gcTime: 0,
    onSuccess: () => client.invalidateQueries({ queryKey: LIST_KEY }),
  });
}

export function useRemoveApiToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => removeApiToken(tokenId),
    onSuccess: () => client.invalidateQueries({ queryKey: LIST_KEY }),
  });
}
