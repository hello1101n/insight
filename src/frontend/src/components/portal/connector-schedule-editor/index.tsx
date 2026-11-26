import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { useEffect, useId, useRef, useState } from "react";

import { ConnectorsApiError } from "@/api/connectors-client";
import type { ScheduleRead } from "@/api/connector-health-client";
import { CronRows } from "./crons";
import { MinuteField } from "./minute";
import { TimeSelect } from "./time";
import { ConnectorScheduleRuns } from "../connector-schedule-runs";
import { rowIndex, violations, type Violation } from "./refusals";
import { saveError } from "./save-error";

import { ConnectorScheduleHeader } from "@/components/portal/connector-schedule-header";
import { ConnectorScheduleTooltip } from "../connector-schedule-tooltip";
import { ConnectorScheduleDetails } from "../connector-schedule-details";
import { resetScheduleTooltip } from "@/lib/portal/connector-schedule-tooltip";
import { scheduleTimePhrase } from "@/lib/portal/connector-schedule-time";
import { validateScheduleCrons } from "@/lib/portal/connector-schedule-validation";
import { isScheduleOverride } from "@/lib/portal/connector-schedule";
import { useConnectorScheduleAuthor } from "@/queries/connector-schedule-author";
import { useHeightTransition } from "@/hooks/use-height-transition";
import {
  Alert,
  Button,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@gears-frontx/ui-kit";
import {
  HOUR_CHOICES,
  choiceCrons,
  detectChoice,
  type ScheduleChoice,
} from "@/lib/portal/connector-schedule-editor";

interface Props {
  read: ScheduleRead;
  save: (etag: string, crons: string[] | null) => Promise<ScheduleRead>;
  reload: () => Promise<ScheduleRead>;
  onClose: () => void;
}

function presetOptions() {
  return [
    ...HOUR_CHOICES.map((hours) => ({
      value: `hours-${hours}`,
      label: i18n.t("connectors.editor.every_hours", { count: hours }),
    })),
    { value: "daily", label: i18n.t("connectors.editor.every_day") },
    { value: "weekdays", label: i18n.t("connectors.editor.every_weekday") },
    { value: "custom", label: i18n.t("connectors.editor.custom_cron") },
  ];
}

function storedCrons(read: ScheduleRead): string[] {
  const { requested, live } = read.schedule;
  return isScheduleOverride(requested) ? requested.crons : (live?.crons ?? []);
}

export function ConnectorScheduleEditor({
  read,
  save,
  reload,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const options = presetOptions();
  const id = useId();
  const [current, setCurrent] = useState(read);
  const [opened, setOpened] = useState(() => storedCrons(read));
  const [choice, setChoice] = useState<ScheduleChoice>(() =>
    detectChoice(storedCrons(read))
  );
  const [error, setError] = useState<string | { kind: "conflict" }>("");
  const [fieldErrors, setFieldErrors] = useState<Violation[]>([]);
  const [errorDetails, setErrorDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const value = choice.kind === "hours" ? `hours-${choice.hours}` : choice.kind;
  const [form, capturePresetHeight] =
    useHeightTransition<HTMLFormElement>(value);
  const runsControl = useRef<HTMLButtonElement>(null);
  const focusRefusal = useRef(false);
  useEffect(() => {
    runsControl.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (busy || !focusRefusal.current) return;
    focusRefusal.current = false;
    const target = form.current?.querySelector<HTMLElement>(
      'input[aria-invalid="true"], [data-refusal]'
    );
    target?.focus();
  }, [busy, error, fieldErrors, form]);
  const crons = choiceCrons(choice);
  const clientErrors =
    choice.kind === "custom" ? validateScheduleCrons(crons) : [];
  const canBuild = crons.length > 0 && clientErrors.length === 0;
  const errors = [...clientErrors, ...fieldErrors];
  const changed = JSON.stringify(crons) !== JSON.stringify(opened);
  const alerts = errors.filter((violation) => {
    const index = rowIndex(violation);
    return choice.kind !== "custom" || index === null || index >= crons.length;
  });
  const preset = options.find((option) => option.value === value);
  const person = useConnectorScheduleAuthor(
    current.schedule.requested?.updated_by
  );
  const author =
    person === t("connectors.schedule.you")
      ? t("connectors.schedule.you_subject")
      : person === t("connectors.schedule.another_admin")
        ? t("connectors.schedule.another_admin_subject")
        : person;
  const message =
    typeof error === "string"
      ? error
      : t(
          person === t("connectors.schedule.you")
            ? "connectors.editor.conflict_self"
            : "connectors.editor.conflict_other",
          {
            author,
            time: scheduleTimePhrase(current.schedule.requested?.updated_at),
          }
        );

  function change(next: ScheduleChoice) {
    setChoice(next);
    setFieldErrors([]);
  }

  function select(nextValue: string) {
    if (nextValue !== value) capturePresetHeight();
    if (nextValue === "custom") {
      change({ kind: "custom", crons: crons.length ? crons : [""] });
    } else if (nextValue === "daily" || nextValue === "weekdays") {
      change({
        kind: nextValue,
        time: choice.kind === "custom" ? "09:00" : choice.time,
      });
    } else {
      change({
        kind: "hours",
        hours: Number(nextValue.slice(6)),
        time: choice.kind === "custom" ? "00:00" : choice.time,
      });
    }
  }

  function prefill(next: ScheduleRead) {
    const crons = storedCrons(next);
    setCurrent(next);
    setOpened(crons);
    setChoice(detectChoice(crons));
  }

  async function submit(reset: boolean) {
    if (!reset) setValidationAttempt((attempt) => attempt + 1);
    if (busy || (!reset && (!canBuild || !changed))) return;
    setBusy(true);
    setError("");
    setErrorDetails("");
    setFieldErrors([]);
    try {
      await save(current.etag, reset ? null : crons);
      onClose();
    } catch (failure) {
      focusRefusal.current = true;
      if (failure instanceof ConnectorsApiError && failure.status === 412) {
        try {
          const next = await reload();
          prefill(next);
          setError({ kind: "conflict" });
        } catch {
          setError(t("connectors.editor.reload_error"));
        }
      } else if (
        failure instanceof ConnectorsApiError &&
        failure.status === 400
      ) {
        const descriptions = violations(failure);
        setFieldErrors(
          descriptions.length
            ? descriptions
            : [
                {
                  description: t("connectors.editor.validation_error"),
                },
              ]
        );
      } else if (failure instanceof ConnectorsApiError) {
        const failureMessage = saveError(
          failure,
          current.schedule.next_reconcile_at
        );
        setError(failureMessage.summary);
        setErrorDetails(failureMessage.details);
        try {
          const next = await reload();
          const running = next.schedule.live?.crons;
          prefill(next);
          if (running) {
            setOpened(running);
            setChoice(detectChoice(running));
          }
        } catch {
          const running = read.schedule.live?.crons ?? opened;
          setCurrent(read);
          setOpened(running);
          setChoice(detectChoice(running));
        }
      } else {
        setError(t("connectors.editor.save_error"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      ref={form}
      data-slot="connector-schedule-editor"
      className="grid max-w-lg min-w-0 grid-cols-1 gap-3 [overflow-wrap:anywhere] whitespace-normal"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <ConnectorScheduleHeader schedule={current.schedule} />
      {message && (
        <Alert role="alert" data-refusal tabIndex={-1} variant="destructive">
          {message}
          {errorDetails && <ConnectorScheduleDetails text={errorDetails} />}
        </Alert>
      )}
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <legend className="sr-only">{t("connectors.schedule.heading")}</legend>
        <div className="min-w-0 space-y-1.5">
          <label
            htmlFor={`${id}-runs`}
            className="block text-xs font-medium text-muted-foreground"
          >
            {t("connectors.editor.runs")}
          </label>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="w-[220px] max-w-full min-w-0">
              <Select
                value={value}
                disabled={busy}
                onValueChange={(next) => {
                  if (typeof next === "string") select(next);
                }}
              >
                <SelectTrigger
                  id={`${id}-runs`}
                  ref={runsControl}
                  size="sm"
                  className="w-full min-w-0"
                >
                  <SelectValue>{preset?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent align="start">
                  {options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {choice.kind !== "custom" && (
              <div className="contents text-sm text-muted-foreground">
                <div className="flex max-w-full min-w-0 items-center gap-2">
                  <span>
                    {choice.kind === "hours"
                      ? choice.hours === 1
                        ? t("connectors.editor.at_minute")
                        : t("connectors.editor.starting")
                      : t("connectors.editor.at")}
                  </span>
                  {choice.kind === "hours" && choice.hours === 1 ? (
                    <MinuteField
                      key={current.etag}
                      value={choice.time.slice(3)}
                      onChange={(minute) =>
                        change({
                          ...choice,
                          time: minute ? `00:${minute}` : "",
                        })
                      }
                    />
                  ) : (
                    <TimeSelect
                      label={
                        choice.kind === "hours"
                          ? t("connectors.editor.start_time")
                          : t("connectors.editor.time")
                      }
                      disabled={busy}
                      value={choice.time}
                      onChange={(time) => change({ ...choice, time })}
                    />
                  )}
                </div>
                <span>{t("common.period.utc")}</span>
              </div>
            )}
          </div>
          {opened.length > 1 && choice.kind !== "custom" && (
            <p className="text-xs text-warning">
              {t("connectors.editor.replaces_expressions", {
                count: opened.length,
              })}
            </p>
          )}
        </div>
        {choice.kind === "custom" && (
          <CronRows
            key={current.etag}
            id={id}
            crons={choice.crons}
            clientErrors={clientErrors}
            errors={fieldErrors}
            validationAttempt={validationAttempt}
            onChange={(crons) => change({ kind: "custom", crons })}
          />
        )}
      </fieldset>
      {(choice.kind !== "custom" || canBuild) && (
        <div className="max-w-full min-w-0 space-y-1 justify-self-start rounded-lg bg-muted p-2.5 text-sm">
          <ConnectorScheduleRuns crons={canBuild ? crons : []} />
          {choice.kind !== "custom" && canBuild && (
            <p className="flex min-w-0 flex-wrap items-baseline gap-x-1 text-xs text-muted-foreground">
              <code className="min-w-0">{crons.join("; ")}</code>{" "}
              <span className="shrink-0">{t("common.period.utc")}</span>
            </p>
          )}
          {!canBuild && choice.kind !== "custom" && (
            <p className="text-destructive">
              {t("connectors.editor.invalid_schedule")}
            </p>
          )}
        </div>
      )}
      {alerts.length > 0 && (
        <Alert role="alert" data-refusal tabIndex={-1} variant="destructive">
          {alerts.map((violation, index) => (
            <p key={index}>{violation.description}</p>
          ))}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {isScheduleOverride(current.schedule.requested) && (
          <ConnectorScheduleTooltip
            content={resetScheduleTooltip(
              current.schedule.inherited,
              current.schedule.next_reconcile_at
            )}
          >
            <Button
              type="button"
              variant="link"
              size="sm"
              className="max-w-full whitespace-normal"
              disabled={busy}
              onClick={() => void submit(true)}
            >
              {t("connectors.editor.reset_default")}
            </Button>
          </ConnectorScheduleTooltip>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onClose}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            loading={busy}
            disabled={!canBuild || !changed}
          >
            {t("common.actions.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
