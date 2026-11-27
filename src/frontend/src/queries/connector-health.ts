import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  getConnectorHealth,
  getConnectorSyncs,
  getConnectorSchedule,
  putConnectorSchedule,
  deleteConnectorSchedule,
  type ScheduleRead,
  type ScheduleStatus,
  type ConnectorHealthSummary,
  type ConnectorHealth,
  type ConnectorInstanceRef,
  type ConnectorSyncHistory,
} from "@/api/connector-health-client";
import { sessionAuthorizationScope } from "@/auth/session-scope";
import { useAuth } from "@/auth/use-auth";
import { instanceKey } from "@/lib/portal/connector-health";

const KEY = ["connector-health"] as const;

const RECHECK_MS = 60_000;
const PENDING_POLL_MS = 30_000;

export function useConnectorHealth(): UseQueryResult<ConnectorHealthSummary> {
  const { session } = useAuth();
  const client = useQueryClient();
  const scope = sessionAuthorizationScope(session);
  return useQuery({
    queryKey: [...KEY, "summary", sessionAuthorizationScope(session)],
    queryFn: async () => {
      const summary = await getConnectorHealth();
      return {
        ...summary,
        connectors: summary.connectors.map((row) => {
          if (summary.schedule_read_error) return row;
          const read = client.getQueryData<ScheduleRead>([
            ...KEY,
            "schedule",
            instanceKey(row),
            scope,
          ]);
          const schedule = read?.schedule;
          if (
            !schedule?.live ||
            (schedule.status !== "applied" && schedule.status !== "inherited")
          )
            return row;
          if (schedule.revision < (row.schedule_request?.revision ?? 0))
            return row;
          if (
            Date.parse(schedule.live.observed_at) <=
            Date.parse(
              row.schedule_request?.last_observation?.observed_at ??
                summary.as_of
            )
          )
            return row;
          return {
            ...row,
            schedule: schedule.live,
            schedule_request:
              schedule.revision > (row.schedule_request?.revision ?? 0)
                ? {
                    revision: schedule.revision,
                    crons: schedule.requested?.crons ?? [],
                    last_observation: {
                      status: schedule.status,
                      observed_at: schedule.live.observed_at,
                    },
                  }
                : row.schedule_request,
          };
        }),
      };
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.data?.connectors.some((row) =>
        scheduleNeedsPolling(row.schedule_request?.last_observation?.status)
      )
        ? PENDING_POLL_MS
        : RECHECK_MS,
  });
}

export function scheduleNeedsPolling(
  status: ScheduleStatus | null | undefined
): boolean {
  return status === "pending";
}

export function useConnectorSchedule(
  instance: ConnectorInstanceRef & Pick<ConnectorHealth, "schedule_request">,
  polling: boolean
): UseQueryResult<ScheduleRead> {
  const { session } = useAuth();
  const query = useQuery({
    queryKey: [
      ...KEY,
      "schedule",
      instanceKey(instance),
      sessionAuthorizationScope(session),
    ],
    queryFn: () => getConnectorSchedule(instance),
    enabled: instance.source_id != null,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (query) => schedulePollInterval(query.state.data, polling),
  });
  const checked = useRef("");
  const hint = instance.schedule_request;
  const identity = `${instanceKey(instance)}/${sessionAuthorizationScope(session)}`;
  const revision = hint?.revision;
  const observedAt = hint?.last_observation?.observed_at;
  const { data, isFetching, refetch } = query;
  useEffect(() => {
    if (!data || isFetching || revision === undefined) return;
    const newer =
      revision > data.schedule.revision ||
      (revision === data.schedule.revision &&
        observedAt !== undefined &&
        Date.parse(observedAt) >
          (data.schedule.live
            ? Date.parse(data.schedule.live.observed_at)
            : 0));
    const stamp = `${identity}/${revision}/${observedAt}`;
    if (newer && checked.current !== stamp) {
      checked.current = stamp;
      void refetch();
    }
  }, [identity, revision, observedAt, data, isFetching, refetch]);
  return query;
}

export function useWriteConnectorSchedule(instance: ConnectorInstanceRef) {
  const client = useQueryClient();
  const { session } = useAuth();
  return useMutation({
    mutationFn: ({ etag, crons }: { etag: string; crons: string[] | null }) =>
      crons === null
        ? deleteConnectorSchedule(instance, etag)
        : putConnectorSchedule(instance, etag, crons),
    onSuccess: async (read) => {
      client.setQueryData(
        [
          ...KEY,
          "schedule",
          instanceKey(instance),
          sessionAuthorizationScope(session),
        ],
        read
      );
      client.setQueryData<ConnectorHealthSummary>(
        [...KEY, "summary", sessionAuthorizationScope(session)],
        (summary) =>
          summary && {
            ...summary,
            connectors: summary.connectors.map((row) =>
              instanceKey(row) === instanceKey(instance)
                ? {
                    ...row,
                    schedule:
                      (read.schedule.status === "applied" ||
                        read.schedule.status === "inherited") &&
                      read.schedule.live
                        ? read.schedule.live
                        : row.schedule,
                    schedule_request: {
                      revision: read.schedule.revision,
                      crons: read.schedule.requested?.crons ?? [],
                      last_observation:
                        read.schedule.live && read.schedule.status
                          ? {
                              status: read.schedule.status,
                              observed_at: read.schedule.live.observed_at,
                            }
                          : null,
                    },
                  }
                : row
            ),
          }
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: [...KEY, "summary"] }),
        client.invalidateQueries({
          queryKey: [...KEY, "schedule", instanceKey(instance)],
        }),
      ]);
    },
  });
}

export function schedulePollInterval(
  read: ScheduleRead | undefined,
  polling: boolean
): number | false {
  return polling || scheduleNeedsPolling(read?.schedule.status)
    ? PENDING_POLL_MS
    : false;
}

export function useConnectorSyncs(
  instance: ConnectorInstanceRef | null
): UseQueryResult<ConnectorSyncHistory> {
  const { session } = useAuth();
  return useQuery({
    queryKey: [
      ...KEY,
      "syncs",
      instance === null ? null : instanceKey(instance),
      sessionAuthorizationScope(session),
    ],
    queryFn: () => getConnectorSyncs(instance as ConnectorInstanceRef),
    enabled: instance !== null,
    staleTime: 0,
    refetchInterval: RECHECK_MS,
  });
}
