import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";

import type {
  Alert,
  AlertDraft,
  AlertPage,
  AlertPreviewRequest,
  NotificationPage,
} from "@/api/alerts-client";
import {
  createAlert,
  deleteAlert,
  fetchAlert,
  fetchAlertDestinations,
  fetchAlertNotifications,
  fetchAlerts,
  previewAlert,
  replaceAlert,
  setAlertEnabled,
} from "@/api/alerts-client";
import { isRevisionConflict } from "@/lib/alerts/conflict";

const ALERTS_PREFIX = ["alerts"] as const;

const PAGE_SIZE = 50;

const NOTIFICATION_PAGE_SIZE = 20;

const LIVE_REFRESH_MS = 30_000;

const LIVE = { staleTime: 0, refetchOnWindowFocus: true } as const;

export function alertPagesQuery(search = "") {
  return infiniteQueryOptions({
    ...LIVE,
    queryKey: [...ALERTS_PREFIX, "list", search],
    queryFn: ({ pageParam }) =>
      fetchAlerts({ search, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last: AlertPage, pages: AlertPage[]) => {
      const read = pages.reduce((count, page) => count + page.alerts.length, 0);
      return read < last.total ? read : undefined;
    },
  });
}

export function alertQuery(id: string) {
  return queryOptions({
    ...LIVE,
    refetchInterval: LIVE_REFRESH_MS,
    queryKey: [...ALERTS_PREFIX, "one", id],
    queryFn: () => fetchAlert(id),
  });
}

export function alertNotificationsQuery(id: string) {
  return infiniteQueryOptions({
    ...LIVE,
    // WORKAROUND: TanStack Query refreshes an infinite query by re-reading
    refetchInterval: (query) =>
      LIVE_REFRESH_MS * (query.state.data?.pages.length ?? 1),
    queryKey: [...ALERTS_PREFIX, "notifications", id],
    queryFn: ({ pageParam }) =>
      fetchAlertNotifications(id, {
        limit: NOTIFICATION_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: (last: NotificationPage) =>
      last.notifications.length < NOTIFICATION_PAGE_SIZE
        ? undefined
        : last.offset + last.notifications.length,
  });
}

export function alertDestinationsQuery() {
  return queryOptions({
    queryKey: [...ALERTS_PREFIX, "destinations"],
    queryFn: fetchAlertDestinations,
  });
}

export function alertPreviewQuery(request: AlertPreviewRequest) {
  return queryOptions({
    queryKey: ["alert-preview", request],
    queryFn: () => previewAlert(request),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

function invalidateAlerts(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: ALERTS_PREFIX });
}

function remember(queryClient: QueryClient, alert: Alert) {
  queryClient.setQueryData(alertQuery(alert.id).queryKey, alert);
  queryClient.setQueriesData<InfiniteData<AlertPage>>(
    { queryKey: [...ALERTS_PREFIX, "list"] },
    (cached) =>
      cached && {
        ...cached,
        pages: cached.pages.map((page) => ({
          ...page,
          alerts: page.alerts.map((row) =>
            row.id === alert.id
              ? {
                  ...row,
                  name: alert.name,
                  metric: alert.metric,
                  enabled: alert.enabled,
                }
              : row
          ),
        })),
      }
  );
}

export function useCreateAlert() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: AlertDraft) => createAlert(draft),
    onSuccess: (alert) => {
      remember(queryClient, alert);
      void invalidateAlerts(queryClient);
    },
  });
}

export function useReplaceAlert() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      draft,
    }: {
      id: string;
      draft: AlertDraft & { expected_revision: number };
    }) => replaceAlert(id, draft),
    onSuccess: (alert) => {
      remember(queryClient, alert);
      void invalidateAlerts(queryClient);
    },
  });
}

export function useReadAlert() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => fetchAlert(id),
    onSuccess: (alert) => remember(queryClient, alert),
  });
}

export function useSetAlertEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      enabled,
      revision,
    }: {
      id: string;
      enabled: boolean;
      revision?: number;
    }) => {
      const expected = revision ?? (await fetchAlert(id)).revision;
      return setAlertEnabled(id, enabled, expected);
    },
    onSuccess: (alert) => {
      remember(queryClient, alert);
      void invalidateAlerts(queryClient);
    },
    onError: (error, { id }) =>
      isRevisionConflict(error)
        ? queryClient.invalidateQueries({ queryKey: alertQuery(id).queryKey })
        : undefined,
  });
}

export function useDeleteAlert() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => deleteAlert(id),
    onSuccess: (_done, id) => {
      queryClient.removeQueries({ queryKey: alertQuery(id).queryKey });
      queryClient.removeQueries({
        queryKey: alertNotificationsQuery(id).queryKey,
      });
      void invalidateAlerts(queryClient);
    },
  });
}
