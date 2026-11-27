import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import {
  bindAccount,
  bindAccounts,
  detachAccount,
  excludeAccount,
  getAccountBinding,
  getAttention,
  getPersonAccounts,
  listPeople,
  listSources,
  mergePersons,
  QUEUE_FIRST_PAGE,
  searchAccounts,
  searchPersons,
  type AccountBinding,
  type AccountSearchResponse,
  type AttentionResponse,
  type CorrectionResponse,
  type PersonAccountEntry,
  type PersonSearchResponse,
} from "@/api/identity-client";
import type { AccountRef } from "@/lib/identities/account-key";
import { dropDecided } from "@/lib/identities/cases";
import { normalizeSources } from "@/lib/identities/sources";
import { useAuth } from "@/auth/use-auth";
import { sessionAuthorizationScope } from "@/auth/session-scope";

function sameList(previous: unknown, picked: readonly string[]): boolean {
  return (
    Array.isArray(previous) &&
    previous.length === picked.length &&
    previous.every((value, index) => value === picked[index])
  );
}

function sameSources(
  previousKey: readonly unknown[],
  picked: readonly string[],
): boolean {
  return sameList(previousKey.at(-1), picked);
}

const ATTENTION_STALE_TIME = 60 * 1000;

export function useAttention(
  limit: number = QUEUE_FIRST_PAGE,
  sources: readonly string[] = [],
  kinds: readonly string[] = [],
): UseQueryResult<AttentionResponse> {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  const picked = normalizeSources(sources);
  const kept = normalizeSources(kinds);
  return useQuery({
    queryKey: ["identity", "resolution", "attention", sessionScope, limit, kept, picked],
    queryFn: () => getAttention(limit, picked, kept),
    staleTime: ATTENTION_STALE_TIME,
    placeholderData: (previous, previousQuery) =>
      previousQuery && sameSources(previousQuery.queryKey, picked)
        ? previous
        : undefined,
    enabled: sessionScope != null,
  });
}

export function useAccountBinding(
  ref: AccountRef | null,
): UseQueryResult<AccountBinding> {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  return useQuery({
    queryKey: [
      "identity",
      "resolution",
      "account",
      sessionScope,
      ref?.source,
      ref?.source_id,
      ref?.account_id,
    ],
    queryFn: () => {
      if (!ref) throw new Error("account ref is missing");
      return getAccountBinding(ref);
    },
    staleTime: ATTENTION_STALE_TIME,
    enabled: sessionScope != null && ref != null,
  });
}

const RESOLUTION_KEY = ["identity", "resolution"] as const;

const PERSON_SEARCH_KEY = ["identity", "persons", "search"] as const;
const PEOPLE_SEARCH_KEY = ["identity", "people", "search"] as const;

type Verb<TArgs> = UseMutationResult<CorrectionResponse, unknown, TArgs>;

function useCorrection<TArgs>(
  run: (args: TArgs) => Promise<CorrectionResponse>,
): Verb<TArgs> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (result) => {
      client.setQueriesData<AttentionResponse>(
        { queryKey: [...RESOLUTION_KEY, "attention"] },
        (previous) =>
          previous
            ? { ...previous, items: dropDecided(previous.items, result.items) }
            : previous,
      );
      void client.invalidateQueries({ queryKey: RESOLUTION_KEY });
      void client.invalidateQueries({ queryKey: PERSON_SEARCH_KEY });
      void client.invalidateQueries({ queryKey: PEOPLE_SEARCH_KEY });
    },
  });
}

export const useBindAccount = () => useCorrection(bindAccount);
export const useBindAccounts = () => useCorrection(bindAccounts);
export const useMergePersons = () => useCorrection(mergePersons);
export const useDetachAccount = () => useCorrection(detachAccount);
export const useExcludeAccount = () => useCorrection(excludeAccount);

const PAGE_SIZE = 50;

export type PersonListIntent = "browse" | "match";
export type PersonListSource = "identities" | "roster";

export type AccountListIntent = "browse" | "match";

export const MAX_SEARCH_CHARS = 200;

export const SEARCH_DEBOUNCE_MS = 400;

export function listsAnyone(q: string, intent: PersonListIntent): boolean {
  return q.trim() !== "" || intent === "browse";
}

export function listsAnyAccount(q: string, intent: AccountListIntent): boolean {
  return q.trim() !== "" || intent === "browse";
}

export function usePersonList(
  q: string,
  intent: PersonListIntent = "browse",
  source: PersonListSource = "identities",
): UseInfiniteQueryResult<InfiniteData<PersonSearchResponse>> {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  const trimmed = q.trim();
  return useInfiniteQuery({
    // WORKAROUND: a disabled query still serves its key's cache, so `intent` keys browse and match apart.
    queryKey:
      source === "roster"
        ? [...PEOPLE_SEARCH_KEY, sessionScope, intent, trimmed]
        : [...PERSON_SEARCH_KEY, sessionScope, intent, trimmed],
    queryFn: async ({ pageParam, signal }) => {
      if (source === "identities") {
        return searchPersons(
          trimmed,
          { cursor: pageParam, limit: PAGE_SIZE },
          signal,
        );
      }

      const page = await listPeople(
        {
          q: trimmed,
          visibility: "tenant",
          cursor: pageParam,
          limit: PAGE_SIZE,
        },
        signal,
      );
      return {
        items: page.items.map((person) => ({
          person_id: person.person_id,
          display_name: person.display_name,
          email: person.email,
          username: person.username,
          job_title: person.attributes.job_title,
          status: person.attributes.status,
        })),
        next_cursor: page.next_cursor,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: ATTENTION_STALE_TIME,
    placeholderData: keepPreviousData,
    enabled: sessionScope != null && listsAnyone(trimmed, intent),
  });
}

export function useAccountList(
  q: string,
  intent: AccountListIntent = "browse",
  sources: readonly string[] = [],
): UseInfiniteQueryResult<InfiniteData<AccountSearchResponse>> {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  const trimmed = q.trim();
  const picked = normalizeSources(sources);
  return useInfiniteQuery({
    // WORKAROUND: a disabled query still serves its key's cache, so `intent` keys browse and match apart.
    queryKey: [
      ...RESOLUTION_KEY,
      "account-search",
      sessionScope,
      intent,
      trimmed,
      picked,
    ],
    queryFn: ({ pageParam, signal }) =>
      searchAccounts(
        trimmed,
        { cursor: pageParam, limit: PAGE_SIZE },
        signal,
        picked,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: ATTENTION_STALE_TIME,
    placeholderData: (previous, previousQuery) =>
      previousQuery && sameSources(previousQuery.queryKey, picked)
        ? previous
        : undefined,
    enabled: sessionScope != null && listsAnyAccount(trimmed, intent),
  });
}

export function useAccountSources(): UseQueryResult<string[]> {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  return useQuery({
    queryKey: [...RESOLUTION_KEY, "sources", sessionScope],
    queryFn: ({ signal }) => listSources(signal),
    staleTime: ATTENTION_STALE_TIME,
    enabled: sessionScope != null,
  });
}

export function usePersonAccounts(
  personId: string | null,
): UseQueryResult<{ person_id: string; accounts: PersonAccountEntry[] }> {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  return useQuery({
    queryKey: [...RESOLUTION_KEY, "person-accounts", sessionScope, personId],
    queryFn: () => {
      if (!personId) throw new Error("person id is missing");
      return getPersonAccounts(personId);
    },
    staleTime: ATTENTION_STALE_TIME,
    enabled: sessionScope != null && personId != null,
  });
}

export interface AccountsToMove {
  ready: boolean;
  failed: boolean;
  accounts: PersonAccountEntry[];
  refetch: () => void;
}

export function usePersonAccountsMany(personIds: string[]): AccountsToMove {
  const { session } = useAuth();
  const sessionScope = sessionAuthorizationScope(session);
  return useQueries({
    queries: personIds.map((personId) => ({
      queryKey: [...RESOLUTION_KEY, "person-accounts", sessionScope, personId],
      queryFn: () => getPersonAccounts(personId),
      staleTime: ATTENTION_STALE_TIME,
      enabled: sessionScope != null,
    })),
    combine: (results) => ({
      ready: results.every((r) => r.data != null),
      failed: results.some((r) => r.isError),
      accounts: results.flatMap((r) => r.data?.accounts ?? []),
      refetch: () => {
        for (const result of results) void result.refetch();
      },
    }),
  });
}
