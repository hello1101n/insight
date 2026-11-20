"""Mirror an Airbyte job's status until completion or sustained unreadability."""

from __future__ import annotations

import http.client
import json
import os
import sys
import time
import urllib.request
from enum import StrEnum
from pathlib import Path
from typing import NamedTuple

import insight_logging
import stage_admission
from airbyte_auth import FatalError, airbyte_api_url, oauth_token

Progress = tuple[str | None, int, int, int]

FAILURE_MESSAGE_MAX_CHARS = 500


class JobStatus(StrEnum):
    PENDING = "pending"
    QUEUED = "queued"
    RUNNING = "running"
    INCOMPLETE = "incomplete"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class SyncFailure(NamedTuple):
    failure_type: str
    origin: str
    external_message: str
    internal_message: str


def _latest_attempt(resp: object) -> dict | None:
    if not isinstance(resp, dict):
        return None
    attempts = resp.get("attempts")
    if not isinstance(attempts, list) or not attempts:
        return None

    attempt = attempts[-1].get("attempt") if isinstance(attempts[-1], dict) else None
    return attempt if isinstance(attempt, dict) else None


def attempt_failures(resp: object) -> list[SyncFailure]:
    attempt = _latest_attempt(resp)
    summary = attempt.get("failureSummary") if attempt is not None else None
    entries = summary.get("failures") if isinstance(summary, dict) else None
    if not isinstance(entries, list):
        return []

    return [_read_failure(entry) for entry in entries if isinstance(entry, dict)]


def attempt_stream_count(resp: object) -> int:
    attempt = _latest_attempt(resp)
    streams = attempt.get("streamStats") if attempt is not None else None
    return len(streams) if isinstance(streams, list) else 0


def succeeded_without_syncing(resp: object) -> bool:
    # INVARIANT: a sync that ran reports one streamStats entry per stream, even at zero records.
    return bool(attempt_failures(resp)) or attempt_stream_count(resp) == 0


def _read_failure(entry: dict) -> SyncFailure:
    return SyncFailure(
        failure_type=_read_text(entry.get("failureType")) or "unknown",
        origin=_read_text(entry.get("failureOrigin")) or "unknown",
        external_message=_read_text(entry.get("externalMessage")),
        internal_message=_read_text(entry.get("internalMessage")),
    )


def _read_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return value[:FAILURE_MESSAGE_MAX_CHARS]


def attempt_progress(resp: dict) -> Progress | None:
    attempts = resp.get("attempts") or []
    if not attempts:
        return None

    attempt = attempts[-1].get("attempt", {})
    stats = attempt.get("totalStats") or {}
    return (
        attempt.get("status"),
        int(stats.get("bytesEmitted") or attempt.get("bytesSynced") or 0),
        int(stats.get("recordsEmitted") or attempt.get("recordsSynced") or 0),
        int(stats.get("stateMessagesEmitted") or 0),
    )


def job_status(resp: object) -> JobStatus | None:
    if not isinstance(resp, dict):
        return None
    job = resp.get("job")
    if not isinstance(job, dict):
        return None
    status = job.get("status")
    if not isinstance(status, str):
        return None
    try:
        return JobStatus(status)
    except ValueError:
        return None


def native_attempt_evidence(item: object) -> dict:
    attempt = item.get("attempt") if isinstance(item, dict) else None
    if not isinstance(attempt, dict):
        return {}
    stats = attempt.get("totalStats")
    failure = attempt.get("failureSummary")
    result = {"status": attempt.get("status")}
    for output, value in [
        ("attempt_id", attempt.get("id")),
        ("ended_at", attempt.get("endedAt")),
        ("records_emitted", stats.get("recordsEmitted") if isinstance(stats, dict) else None),
        ("records_committed", stats.get("recordsCommitted") if isinstance(stats, dict) else None),
    ]:
        if type(value) is int and value >= 0:
            result[output] = value
    if isinstance(failure, dict):
        result["failure_origins"] = [f.origin for f in attempt_failures({"attempts": [item]})]
        if isinstance(failure.get("partialSuccess"), bool):
            result["partial_success"] = failure["partialSuccess"]
    return result


def save_terminal_evidence(job_id: int, resp: dict, status: str) -> None:
    path = os.environ.get("AIRBYTE_EVIDENCE_PATH")
    if not path or str(resp["job"].get("id")) != str(job_id):
        return
    attempt = _latest_attempt(resp) or {}
    stats = attempt.get("totalStats") or {}
    evidence = {"job_id": job_id, "status": status}
    if isinstance(resp.get("attempts"), list):
        evidence["attempts"] = [native_attempt_evidence(item) for item in resp["attempts"]]
    for key, total_key, legacy_key in [
        ("records_reported", "recordsEmitted", "recordsSynced"),
        ("volume_bytes", "bytesEmitted", "bytesSynced"),
    ]:
        count = stats.get(total_key, attempt.get(legacy_key)) if isinstance(stats, dict) else None
        if type(count) is int and count >= 0:
            evidence[key] = count
    Path(path).write_text(json.dumps(evidence))


def airbyte_job(airbyte_url: str, token: str, action: str, job_id: int) -> dict:
    request = urllib.request.Request(
        f"{airbyte_url}/api/v1/jobs/{action}",
        data=json.dumps({"id": job_id}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def cancel_if_pending(airbyte_url: str, token: str, job_id: int) -> bool:
    if stage_admission.request("POST", "/airbyte-poll", max_wait_seconds=0, job_id=job_id).get("cancel") is not True:
        return False
    current = airbyte_job(airbyte_url, token, "get", job_id)
    if str((current.get("job") or {}).get("id")) != str(job_id):
        return False
    if job_status(current) not in (JobStatus.PENDING, JobStatus.QUEUED, JobStatus.RUNNING):
        return False
    if stage_admission.request("POST", "/airbyte-poll", max_wait_seconds=0, job_id=job_id).get("cancel") is not True:
        return False
    airbyte_job(airbyte_url, token, "cancel", job_id)
    return True


def main() -> int:
    log = insight_logging.configure("airbyte-sync")

    job_id = int(os.environ["JOB_ID"])
    try:
        airbyte_url = airbyte_api_url()
    except FatalError as error:
        log.error(f"FAIL: {error}")
        return 1
    poll_interval = int(os.environ["POLL_INTERVAL_SECONDS"])
    unreadable_threshold = int(os.environ["STATUS_UNREADABLE_THRESHOLD_SECONDS"])

    t0 = time.monotonic()
    last_progress: Progress | None = None
    last_readable_at = t0
    cancel_sent = False
    managed = os.environ.get("ADMISSION_MANAGED") == "true"

    def emit_completed(status: str, exit_code: int) -> None:
        progress = last_progress or (None, 0, 0, 0)
        (log.info if exit_code == 0 else log.error)(
            "sync finished",
            extra={
                "event": "sync.completed",
                "job_id": job_id,
                "status": status,
                "duration_ms": int((time.monotonic() - t0) * 1000),
                "bytes": progress[1],
                "records": progress[2],
            },
        )

    def emit_failure_reasons(resp: object) -> None:
        for failure in attempt_failures(resp):
            log.error(
                "sync failure reason",
                extra={
                    "event": "sync.failure_reason",
                    "job_id": job_id,
                    "failure_type": failure.failure_type,
                    "failure_origin": failure.origin,
                    "external_message": failure.external_message,
                    "internal_message": failure.internal_message,
                },
            )

    def retry_or_give_up(reason: str) -> bool:
        unreadable_for = time.monotonic() - last_readable_at
        if unreadable_for >= unreadable_threshold:
            log.error(
                "Cannot read Airbyte job status; sync outcome is unknown",
                extra={"event": "sync.poll_failed", "job_id": job_id, "unreadable_for_s": int(unreadable_for)},
            )
            return False
        log.warning(f"poll: {reason}; retrying in {poll_interval}s")
        time.sleep(poll_interval)
        return True

    while True:
        try:
            token = oauth_token()
            resp = airbyte_job(airbyte_url, token, "get", job_id)
        except FatalError as error:
            log.error(f"FAIL: {error}", extra={"event": "sync.poll_failed", "job_id": job_id})
            return 1
        except Exception as error:  # noqa: BLE001
            if not retry_or_give_up(f"transient error fetching job status: {error!r}"):
                return 2
            continue

        status = job_status(resp)
        if status is None or (managed and str(resp["job"].get("id")) != str(job_id)):
            if not retry_or_give_up("unusable job status"):
                return 2
            continue
        last_readable_at = time.monotonic()
        try:
            progress = attempt_progress(resp)
        except (AttributeError, IndexError, KeyError, TypeError, ValueError, OverflowError):
            progress = None
            log.warning("Unreadable progress counters", extra={"job_id": job_id})

        if progress is not None and progress != last_progress:
            last_progress = progress
            log.info(
                "sync progress",
                extra={
                    "job_id": job_id,
                    "status": status,
                    "bytes": progress[1],
                    "records": progress[2],
                    "states": progress[3],
                },
            )
        else:
            log.info("waiting for sync completion", extra={"job_id": job_id, "status": status})

        if status == JobStatus.SUCCEEDED and succeeded_without_syncing(resp):
            log.error(
                "Airbyte reported success, but the latest attempt recorded failures or synced no streams",
                extra={"event": "sync.not_run", "job_id": job_id, "streams": attempt_stream_count(resp)},
            )
            emit_failure_reasons(resp)
            save_terminal_evidence(job_id, resp, "failed")
            emit_completed("failed", 1)
            return 1
        if status == JobStatus.SUCCEEDED:
            log.info("Sync complete")
            save_terminal_evidence(job_id, resp, "succeeded")
            emit_completed("succeeded", 0)
            return 0
        if status in (JobStatus.FAILED, JobStatus.CANCELLED):
            log.error(f"Sync failed: {status}")
            emit_failure_reasons(resp)
            save_terminal_evidence(job_id, resp, status.value)
            emit_completed(status, 1)
            return 1

        if managed and not cancel_sent:
            try:
                cancel_sent = cancel_if_pending(airbyte_url, token, job_id)
            except (OSError, ValueError, http.client.HTTPException, stage_admission.AdmissionError) as error:
                log.warning("cannot confirm pending cancellation for Airbyte job %s: %s", job_id, error)
        time.sleep(poll_interval)


if __name__ == "__main__":
    sys.exit(main())
