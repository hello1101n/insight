"""Trigger one Airbyte connection sync and hand the job id to the poll step.

Runs as the airbyte-sync workflow's trigger step, on the toolbox image; every
workflow-time parameter arrives via the environment (see the SECURITY note in
charts/insight/templates/ingestion/airbyte-sync.yaml).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

import insight_logging
from airbyte_auth import FatalError, airbyte_api_url, oauth_token, request
from airbyte_launch import Launch, WorkflowLaunch, read_claim
from airbyte_resources import AirbyteResources, Sizes, parse
from pydantic import BaseModel, ConfigDict, Field, PositiveInt, StringConstraints, ValidationError

REJECTED = 42
UNCONFIRMED = 43
UNREADABLE = 44
WRITE_ATTEMPTS = 5
POLL_INTERVAL_SECONDS = 10


class Job(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: Annotated[int, Field(strict=True, gt=0)] | Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]*$")]


class TriggerResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    job: Job


class JobStatus(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: PositiveInt
    connection: UUID = Field(alias="configId")
    kind: Literal["sync"] = Field(alias="configType")
    status: str


class JobStatusResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    job: JobStatus


class ListedJob(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: PositiveInt = Field(alias="jobId")
    connection: UUID = Field(alias="connectionId")
    kind: str = Field(alias="jobType")


class JobList(BaseModel):
    model_config = ConfigDict(frozen=True)

    data: tuple[ListedJob, ...]
    next: str | None = None

    def ids(self, connection: UUID) -> tuple[int, ...]:
        ids = tuple(job.id for job in self.data)
        if (
            len(ids) > 2
            or (len(ids) < 2 and self.next)
            or any(job.connection != connection or job.kind != "sync" for job in self.data)
            or len(ids) == 2
            and ids[0] <= ids[1]
        ):
            raise ValueError("Unexpected Airbyte sync history")
        return ids


def jobs(url: str, connection: UUID, token: str) -> tuple[int, ...]:
    query = urllib.parse.urlencode(
        {"connectionId": str(connection), "jobType": "sync", "limit": 2, "orderBy": "createdAt|DESC"}
    )
    return JobList.model_validate_json(request(f"{url}/api/public/v1/jobs?{query}", token)).ids(connection)


def triggered_job_id(body: bytes) -> int | str | None:
    """The job id from a connections/sync payload; None when the shape is unusable."""
    try:
        return TriggerResponse.model_validate_json(body).job.id
    except ValidationError:
        return None


def send(url: str, token: str, claim: Launch) -> Launch:
    body = json.dumps({"connectionId": str(claim.connection)}).encode()
    try:
        reply = request(f"{url}/api/v1/connections/sync", token, body)
        job = triggered_job_id(reply)
    except urllib.error.HTTPError as error:
        if 400 <= error.code < 500 and error.code not in (408, 429):
            return claim.model_copy(update={"outcome": "rejected"})
        return claim
    except OSError:
        return claim
    if job is None:
        return claim
    return claim.model_copy(update={"outcome": "accepted", "job_id": int(job)})


def confirm(url: str, claim: Launch) -> Launch:
    log = insight_logging.configure("airbyte-sync")
    while True:
        try:
            ids = jobs(url, claim.connection, oauth_token())
        except (FatalError, OSError, ValueError, KeyError):
            log.warning("Airbyte job list is unavailable.")
            next_check = claim.read_deadline
            if time.time() >= next_check:
                return claim.model_copy(update={"outcome": "unreadable"})
        else:
            newer = [job for job in ids if job > claim.previous_job]
            if len(newer) == 1:
                return claim.model_copy(update={"outcome": "accepted", "job_id": newer[0]})
            next_check = claim.deadline
            if time.time() >= next_check:
                if not newer:
                    return claim.model_copy(update={"outcome": "unconfirmed"})
                raise RuntimeError("Airbyte job history does not identify one launch")
        time.sleep(max(0, min(POLL_INTERVAL_SECONDS, next_check - time.time())))


def finished_job(url: str, claim: Launch) -> bool:
    if claim.job_id is None:
        return False
    body = json.dumps({"id": claim.job_id}).encode()
    try:
        job = JobStatusResponse.model_validate_json(request(f"{url}/api/v1/jobs/get", oauth_token(), body)).job
    except (OSError, ValueError, KeyError):
        return False
    return (
        job.id == claim.job_id
        and job.connection == claim.connection
        and job.status in {"succeeded", "failed", "cancelled"}
    )


def retryable_write(error: OSError) -> bool:
    return not isinstance(error, urllib.error.HTTPError) or error.code == 409 or error.code >= 500


def save_receipt(store: WorkflowLaunch, claim: Launch, result: Launch) -> Launch:
    if result.outcome in {"rejected", "unconfirmed", "unreadable"}:
        result = result.model_copy(update={"outcome_at": datetime.fromtimestamp(time.time(), UTC)})
    for _ in range(WRITE_ATTEMPTS):
        try:
            metadata = store.read()
            current = read_claim(metadata, claim.connection)
            if current != claim:
                if current is not None and current.attempt == claim.attempt and current.outcome != "pending":
                    return current
                return result
            store.write(metadata, result)
            return result
        except OSError as error:
            if not retryable_write(error):
                break
        except ValueError:
            continue
    insight_logging.configure("airbyte-sync").warning("The Workflow launch receipt write did not complete.")
    return result


def recover(url: str, claim: Launch, trigger_receipt: Launch | None) -> Launch:
    result = claim
    if (
        claim.outcome == "pending"
        and trigger_receipt is not None
        and trigger_receipt.outcome == "accepted"
        and trigger_receipt.workflow_uid == claim.workflow_uid
        and trigger_receipt.connection == claim.connection
        and trigger_receipt.attempt == claim.attempt
    ):
        result = claim.model_copy(update={"outcome": "accepted", "job_id": trigger_receipt.job_id})
    if result.outcome in {"pending", "unreadable"}:
        result = confirm(url, claim)
    return result


def launch(
    store: WorkflowLaunch,
    url: str,
    connection: UUID,
    window: int,
    unreadable_window: int,
    trigger_receipt: Launch | None = None,
    *,
    workflow_read_seconds: int = 0,
    sizes: Sizes | None = None,
) -> Launch:
    read_deadline = time.monotonic() + workflow_read_seconds if workflow_read_seconds > 0 else None
    for _ in range(WRITE_ATTEMPTS):
        metadata = store.read() if read_deadline is None else store.read_until(read_deadline)
        if metadata.started_at is None:
            raise RuntimeError("Workflow start is unavailable")
        prior = read_claim(metadata, connection)
        previous_job = None
        if prior is not None and (
            prior.workflow_started_at == metadata.started_at
            or (prior.outcome not in {"rejected", "unconfirmed"} and not finished_job(url, prior))
        ):
            recovered = recover(url, prior, trigger_receipt)
            if prior.workflow_started_at == metadata.started_at or recovered.outcome != "unconfirmed":
                result = recovered.model_copy(update={"workflow_started_at": metadata.started_at})
                return save_receipt(store, prior, result) if result != prior else result
            previous_job = prior.previous_job

        token = oauth_token()
        if previous_job is None:
            before = jobs(url, connection, token)
            previous_job = before[0] if before else 0
        if sizes is not None:
            overrides = AirbyteResources(request, url).converge(token, connection, sizes)
            if overrides:
                insight_logging.configure("airbyte-sync").warning(
                    "The Airbyte connection overrides the source resource settings.",
                    extra={"connection_id": str(connection), "fields": overrides},
                )

        now = time.time()
        claim = Launch(
            workflow_uid=metadata.uid,
            workflow_started_at=metadata.started_at,
            attempt=prior.attempt + 1 if prior is not None else 1,
            connection=connection,
            previous_job=previous_job,
            deadline=now + window,
            read_deadline=now + unreadable_window,
        )
        try:
            store.write(metadata, claim)
        except urllib.error.HTTPError as error:
            if error.code != 409:
                raise
            continue

        result = send(url, token, claim)
        if result.outcome == "pending":
            result = confirm(url, claim)
        return save_receipt(store, claim, result)

    raise RuntimeError("The Workflow launch claim write conflicted.")


def workflow_launch(url: str, trigger_receipt: Launch | None = None, *, workflow_read_seconds: int = 0) -> Launch:
    connection = UUID(os.environ["CONNECTION_ID"])
    window = int(os.environ["LAUNCH_CONFIRMATION_SECONDS"])
    unreadable_window = int(os.environ["LAUNCH_UNREADABLE_SECONDS"])
    if min(window, unreadable_window) <= 0:
        raise ValueError("Airbyte launch windows must be positive")
    sizes = parse(Sizes, os.environ["SYNC_RESOURCES"]) if "SYNC_RESOURCES" in os.environ else None
    return launch(
        WorkflowLaunch(),
        url,
        connection,
        window,
        unreadable_window,
        trigger_receipt,
        workflow_read_seconds=workflow_read_seconds,
        sizes=sizes,
    )


def report_launch(result: Launch) -> int:
    log = insight_logging.configure("airbyte-sync")
    if path := os.environ.get("AIRBYTE_LAUNCH_EVIDENCE_PATH"):
        try:
            Path(path).write_text(result.model_dump_json())
        except OSError:
            log.warning("The Argo launch receipt write did not complete.")
    match result.outcome:
        case "rejected":
            log.error("Airbyte rejected the sync request.")
            return REJECTED
        case "unconfirmed":
            log.error("The Airbyte sync confirmation window expired.")
            return UNCONFIRMED
        case "unreadable":
            log.error("The Airbyte job list remained unreadable.")
            return UNREADABLE
        case "accepted":
            return 0
        case "pending":
            return 1


def main() -> int:
    log = insight_logging.configure("airbyte-sync")
    try:
        result = workflow_launch(airbyte_api_url())
        exit_code = report_launch(result)
    except (FatalError, OSError, ValueError, RuntimeError, KeyError) as error:
        log.error("Airbyte launch evidence is unavailable.", extra={"error_type": type(error).__name__})
        return 1

    if exit_code:
        return exit_code
    log.info(
        "Airbyte sync job is available.",
        extra={"event": "sync.triggered", "connection_id": str(result.connection), "job_id": result.job_id},
    )
    print(result.job_id)  # noqa: T201 -- stdout is the Argo result
    return 0


if __name__ == "__main__":
    sys.exit(main())
