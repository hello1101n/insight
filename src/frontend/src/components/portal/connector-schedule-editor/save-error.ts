import i18n from "@/i18n";
import { ConnectorsApiError } from "@/api/connectors-client";
import { scheduleTime } from "@/lib/portal/connector-schedule-time";

export function saveError(
  error: unknown,
  nextCheck?: string | null
): {
  summary: string;
  details: string;
} {
  const body =
    error instanceof ConnectorsApiError
      ? (error.body as { detail?: unknown } | null)
      : null;
  const detail = typeof body?.detail === "string" ? body.detail : "";
  const defaultUnavailable = detail.includes(
    "Reset requires the deployment schedule annotation"
  );
  if (detail.startsWith("The request is saved but not applied:")) {
    return {
      summary: i18n.t("connectors.save_error.request_not_applied"),
      details: detail,
    };
  }
  if (defaultUnavailable) {
    return {
      summary: nextCheck
        ? i18n.t("connectors.save_error.reset_error_at", {
            time: scheduleTime(nextCheck),
          })
        : i18n.t("connectors.save_error.reset_error"),
      details: detail,
    };
  }
  if (!detail.startsWith("The schedule was not changed:")) {
    return {
      summary: detail || i18n.t("connectors.save_error.save_error"),
      details: "",
    };
  }
  let summary = i18n.t("connectors.save_error.not_changed");
  if (detail.includes("the cluster returned an error")) {
    summary = i18n.t("connectors.save_error.cluster_error");
  } else if (
    detail.includes("did not answer in time") ||
    detail.includes("timed out")
  ) {
    summary = i18n.t("connectors.save_error.cluster_timeout");
  } else if (detail.includes("the cluster refused the change")) {
    summary = i18n.t("connectors.save_error.cluster_refused");
  }
  return { summary, details: detail };
}
