import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

import type {
  AppliedSchedule,
  ConnectorHealth,
  ScheduleRead,
} from "@/api/connector-health-client";
import { ConnectorsApiError } from "@/api/connectors-client";
import {
  Alert,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  toast,
} from "@gears-frontx/ui-kit";
import { ConnectorScheduleHeader } from "./connector-schedule-header";
import { ConnectorScheduleStatus } from "./connector-schedule-status";
import { ConnectorScheduleEditor } from "./connector-schedule-editor";
import { ConnectorScheduleRuns } from "./connector-schedule-runs";
import { ConnectorScheduleDetails } from "./connector-schedule-details";
import { saveError } from "./connector-schedule-editor/save-error";
import {
  conciseScheduleWords,
  scheduleTransitionMessage,
} from "@/lib/portal/connector-schedule-display";
import { scheduleTimePhrase } from "@/lib/portal/connector-schedule-time";
import { instanceKey } from "@/lib/portal/connector-health";
import { isScheduleOverride } from "@/lib/portal/connector-schedule";
import {
  useConnectorSchedule,
  useWriteConnectorSchedule,
} from "@/queries/connector-health";
import { useConnectorScheduleAuthor } from "@/queries/connector-schedule-author";
import { useHeightTransition } from "@/hooks/use-height-transition";

export function ConnectorSchedulePane({
  row,
  polling,
  reconcileIntervalSecs,
  collapseDetails = false,
}: {
  row: ConnectorHealth;
  polling: boolean;
  reconcileIntervalSecs?: number | null;
  collapseDetails?: boolean;
}) {
  const { t } = useTranslation();
  const query = useConnectorSchedule(row, polling);
  const write = useWriteConnectorSchedule(row);
  const [failedRevision, setFailedRevision] = useState<number>();
  const [editing, setEditing] = useState(false);
  const [scheduleBody, captureScheduleHeight] = useHeightTransition(editing);
  const [detailsOpen, setDetailsOpen] = useState(!collapseDetails);
  const [retryError, setRetryError] = useState<
    (ReturnType<typeof saveError> & { read: ScheduleRead }) | null
  >(null);
  const retrying = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const focusedRequest = useRef(0);
  const observed = query.data?.schedule;
  const schedule = row.source_id == null ? undefined : observed;
  const visibleRetryError =
    retryError &&
    schedule?.status === "pending" &&
    retryError.read.schedule.connector === schedule.connector &&
    retryError.read.schedule.source_id === schedule.source_id &&
    retryError.read.schedule.pending_reason === schedule.pending_reason &&
    retryError.read.schedule.revision === schedule.revision &&
    retryError.read.schedule.requested?.updated_at ===
      schedule.requested?.updated_at
      ? retryError
      : null;
  if (retryError && !visibleRetryError) setRetryError(null);
  const identity = instanceKey(row);
  const [seen, setSeen] = useState({
    identity,
    status: observed?.status,
    revision: observed?.revision,
    message: "",
  });
  if (
    identity !== seen.identity ||
    observed?.status !== seen.status ||
    observed?.revision !== seen.revision
  ) {
    const message =
      identity === seen.identity &&
      seen.status !== undefined &&
      seen.revision !== undefined &&
      observed &&
      observed.revision >= seen.revision &&
      observed.revision !== failedRevision
        ? scheduleTransitionMessage(observed)
        : "";
    setSeen({
      identity,
      status: observed?.status,
      revision: observed?.revision,
      message,
    });
  }

  useEffect(() => {
    if (seen.message)
      toast.add({
        type: "success",
        title: seen.message,
      });
  }, [seen]);

  useEffect(() => {
    if (editing || write.isPending || focusRequest === focusedRequest.current)
      return;
    editButton.current?.focus({ preventScroll: true });
    focusedRequest.current = focusRequest;
  }, [editing, focusRequest, write.isPending]);

  function close() {
    captureScheduleHeight();
    setFocusRequest((request) => request + 1);
    setEditing(false);
  }
  async function reload(): Promise<ScheduleRead> {
    const result = await query.refetch();
    if (result.error || !result.data)
      throw (
        result.error ?? new Error(t("connectors.schedule.unavailable_error"))
      );
    return result.data;
  }

  async function save(etag: string, crons: string[] | null) {
    try {
      const result = await write.mutateAsync({ etag, crons });
      setFailedRevision(undefined);
      return result;
    } catch (error) {
      setFailedRevision(schedule?.revision);
      throw error;
    }
  }

  async function saveAgain() {
    const read = query.data;
    const request = read?.schedule.requested;
    if (!read || !request || write.isPending || retrying.current) return;
    retrying.current = true;
    setRetryError(null);
    setFailedRevision(undefined);
    try {
      await write.mutateAsync({
        etag: read.etag,
        crons: isScheduleOverride(request) ? request.crons : null,
      });
      setFocusRequest((request) => request + 1);
    } catch (error) {
      if (error instanceof ConnectorsApiError && error.status === 412) {
        const { data, error: reloadError } = await query.refetch();
        if (reloadError || !data) return;
        setRetryError({
          read: data,
          summary: t("connectors.schedule.overdue_conflict"),
          details: "",
        });
      } else {
        setRetryError({
          read,
          ...saveError(error, read.schedule.next_reconcile_at),
        });
      }
    } finally {
      retrying.current = false;
    }
  }

  const request = schedule?.requested;
  const override = isScheduleOverride(request);
  const differs = schedule?.status === "pending" || schedule?.status === null;
  const live = schedule ? schedule.live : row.schedule;
  const displayed = differs
    ? override
      ? { crons: request.crons, timezone: "UTC", suspended: false }
      : schedule?.inherited
        ? { ...schedule.inherited, timezone: "UTC", suspended: false }
        : null
    : live;
  const person = useConnectorScheduleAuthor(request?.updated_by);

  return (
    <div
      ref={scheduleBody}
      data-slot="connector-schedule-pane"
      className="min-w-0"
    >
      <div aria-live="polite" className="sr-only">
        <span key={`${seen.identity}/${seen.revision}/${seen.status}`}>
          {seen.message}
        </span>
      </div>
      {editing && schedule && query.data ? (
        <ConnectorScheduleEditor
          read={query.data}
          save={save}
          reload={reload}
          onClose={close}
        />
      ) : (
        <Collapsible
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          className="min-w-0 [overflow-wrap:anywhere] whitespace-normal"
        >
          <ConnectorScheduleHeader
            schedule={schedule}
            loading={query.isPending && !schedule && row.source_id != null}
            heading={
              collapseDetails ? (
                <CollapsibleTrigger
                  type="button"
                  className="group inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-sm focus-visible:outline-2"
                >
                  {t("connectors.schedule.heading")}
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none"
                  />
                </CollapsibleTrigger>
              ) : undefined
            }
          >
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-3">
              {override && (
                <span className="text-xs text-muted-foreground">
                  {t("connectors.schedule.request_author", {
                    person,
                    time: scheduleTimePhrase(request.updated_at),
                  })}
                </span>
              )}
              {schedule && (
                <Button
                  ref={editButton}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={write.isPending}
                  onClick={() => {
                    captureScheduleHeight();
                    setEditing(true);
                  }}
                >
                  {t("common.actions.edit")}
                </Button>
              )}
            </div>
          </ConnectorScheduleHeader>
          <CollapsibleContent>
            <div className="space-y-3 pt-2">
              <div
                className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm"
                data-slot="schedule-value"
              >
                <ScheduleValue
                  schedule={displayed}
                  defaultUnknown={differs && !override}
                />
              </div>
              {schedule?.status === "inherited" &&
                schedule.inherited?.origin === "annotation" && (
                  <ConnectorScheduleDetails text="insight.cyberfabric.com/schedule" />
                )}
              {!differs && live?.timezone && (
                <ConnectorScheduleRuns
                  crons={live.crons}
                  timezone={live.timezone}
                  suspended={live.suspended}
                />
              )}
            </div>
          </CollapsibleContent>
          {schedule && (
            <ConnectorScheduleStatus
              schedule={schedule}
              reconcileIntervalSecs={reconcileIntervalSecs}
              onSaveAgain={() => void saveAgain()}
              saving={write.isPending}
            />
          )}
          {visibleRetryError && (
            <Alert role="alert" variant="destructive">
              {visibleRetryError.summary}
              {visibleRetryError.details && (
                <ConnectorScheduleDetails text={visibleRetryError.details} />
              )}
            </Alert>
          )}
          {query.isPending && row.source_id != null && (
            <p className="text-sm text-muted-foreground">
              {t("connectors.schedule.loading")}
            </p>
          )}
          {query.isError && (
            <div className="text-sm text-destructive">
              {t("connectors.schedule.load_error")}{" "}
              <Button
                variant="link"
                size="sm"
                onClick={() => void query.refetch()}
              >
                {t("common.actions.retry")}
              </Button>
            </div>
          )}
        </Collapsible>
      )}
    </div>
  );
}

function ScheduleValue({
  schedule,
  defaultUnknown,
}: {
  schedule: AppliedSchedule | null | undefined;
  defaultUnknown: boolean;
}) {
  const { t } = useTranslation();
  if (!schedule)
    return (
      <span>
        {defaultUnknown ? t("connectors.schedule.default_schedule") : "—"}
      </span>
    );
  if (!schedule.crons.length)
    return <span>{t("connectors.schedule.default_schedule")}</span>;
  return (
    <>
      {schedule.timezone === "UTC" && (
        <span className="font-medium">
          {conciseScheduleWords(schedule.crons)}
        </span>
      )}
      <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
        {schedule.crons.join("; ")}
      </code>
      <span className="text-xs text-muted-foreground">
        {!schedule.timezone && schedule.suspended
          ? t("connectors.schedule_suspended", {
              timezone: t("connectors.controller_time"),
            })
          : (schedule.timezone ?? t("connectors.controller_time"))}
      </span>
    </>
  );
}
