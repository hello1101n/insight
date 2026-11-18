import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";

import {
  createSqlToken,
  listSqlTokens,
  removeSqlToken,
  type SqlTokenList,
  type SqlTokenRequest,
} from "@/api/sql-tokens-client";
import { sessionAuthorizationScope } from "@/auth/session-scope";
import { useAuth } from "@/auth/use-auth";

const LIST_KEY = ["sql-tokens", "list"] as const;

export function useSqlTokens(): UseQueryResult<SqlTokenList> {
  const { session } = useAuth();
  return useQuery({
    queryKey: [...LIST_KEY, sessionAuthorizationScope(session)],
    queryFn: listSqlTokens,
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useCreateSqlToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: SqlTokenRequest) => createSqlToken(body),
    gcTime: 0,
    onSuccess: () => client.invalidateQueries({ queryKey: LIST_KEY }),
  });
}

export function useRemoveSqlToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => removeSqlToken(tokenId),
    onSuccess: () => client.invalidateQueries({ queryKey: LIST_KEY }),
  });
}
