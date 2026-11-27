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
from contextlib import nullcontext
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

import insight_logging
from airbyte_admission import (
    CHECK_INTERVAL_SECONDS,
    POD_OBSERVATION_SECONDS,
    Admission,
    CapacityUnreadable,
    CheckOutage,
    capacity_wait,
    next_attempt,
    start_wait,
)
from airbyte_auth import FatalError, airbyte_api_url, oauth_token, request
from airbyte_estimate import estimate
from airbyte_launch import (
    CLAIM_WRITE_TIMEOUT_SECONDS,
    REQUEST_TIMEOUT_SECONDS,
    CapacityWait,
    Launch,
    WorkflowLaunch,
    WorkflowMetadata,
    WorkflowReadTimeout,
    read_claim,
)
from airbyte_resources import AirbyteResources, Sizes, parse
from api_response import capacity_check_enabled, parse_response, transient_error
from capacity_lease import CapacityConfigurationError, HeldLease, LeaseLost
from pod_capacity import Capacity
from pydantic import BaseModel, ConfigDict, Field, PositiveInt, StringConstraints, ValidationError

REJECTED = 42
UNCONFIRMED = 43
UNREADABLE = 44
CAPACITY_CONFIGURATION = 45
POD_TOO_LARGE = 46
CAPACITY_WAIT_EXCEEDED = 47
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
    raw = request(f"{url}/api/public/v1/jobs?{query}", token)
    return parse_response(JobList, raw, enabled=capacity_check_enabled()).ids(connection)


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


def finished_job(url: str, claim: Launch, *, strict: bool) -> bool:
    if claim.job_id is None:
        return False
    body = json.dumps({"id": claim.job_id}).encode()
    try:
        raw = request(f"{url}/api/v1/jobs/get", oauth_token(), body)
        job = parse_response(JobStatusResponse, raw, enabled=capacity_check_enabled()).job
    except (OSError, ValueError, KeyError):
        if strict:
            raise
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
        result = claim.model_copy(
            update={"outcome": "accepted", "job_id": trigger_receipt.job_id, "pod_request": trigger_receipt.pod_request}
        )
    if result.outcome in {"pending", "unreadable"}:
        result = confirm(url, claim)
    return result


def prepare(url: str, token: str, connection: UUID, previous_job: int | None, sizes: Sizes | None) -> int:
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
    return previous_job


def observe_launch(result: Launch, capacity: Admission, lease: HeldLease, deadline: float) -> Launch:
    error = None
    request = None
    try:
        if result.outcome == "accepted":
            request = capacity.observe(result, lease, deadline)
    except (OSError, ValueError, RuntimeError, KeyError) as failure:
        error = failure
    finally:
        lease.close()
    log = insight_logging.configure("airbyte-sync")
    if error := error or lease.error:
        log.warning(
            "The Airbyte pod request measurement did not complete.",
            extra={"job_id": result.job_id, "error_type": type(error).__name__},
        )
        return result
    if request is None or result.estimated_pod_request is None:
        return result
    if request != result.estimated_pod_request:
        log.warning(
            "The Airbyte pod request differs from the estimate.",
            extra={
                "job_id": result.job_id,
                "estimated": result.estimated_pod_request.model_dump(),
                "actual": request.model_dump(),
            },
        )
    return result.model_copy(update={"pod_request": request})


def write_claim(
    store: WorkflowLaunch, metadata: WorkflowMetadata, claim: Launch, wait: CapacityWait | None, lease: HeldLease | None
) -> None:
    if lease is None and wait is None:
        store.write(metadata, claim)
        return
    try:
        if wait is not None and wait.ended_at is None:
            ended_at = max(wait.started_at, claim.outcome_at or datetime.now(UTC))
            ended = wait.model_copy(update={"ended_at": ended_at})
            store.write_with_wait(metadata, claim, ended)
        else:
            store.write(metadata, claim, timeout=CLAIM_WRITE_TIMEOUT_SECONDS)
    except OSError as error:
        if not transient_error(error):
            raise
        current = store.read()
        if current.started_at != claim.workflow_started_at or read_claim(current, claim.connection) != claim:
            raise
        if claim.outcome == "pending" and lease is not None:
            lease.ensure_held(REQUEST_TIMEOUT_SECONDS)


def launch(
    store: WorkflowLaunch,
    url: str,
    connection: UUID,
    window: int,
    unreadable_window: int,
    trigger_receipt: Launch | None = None,
    *,
    workflow_read_seconds: int | None = None,
    sizes: Sizes | None = None,
    capacity_enabled: bool = False,
) -> Launch:
    read_deadline = (
        time.monotonic() + workflow_read_seconds if workflow_read_seconds and workflow_read_seconds > 0 else None
    )
    outage = CheckOutage(unreadable_window)
    capacity = None
    conflicts = 0
    initial_read = True
    while conflicts < WRITE_ATTEMPTS:
        started = time.monotonic()
        claim_written = False
        operation = "Read the Workflow"
        try:
            if read_deadline is not None and (initial_read or not capacity_enabled):
                metadata = store.read_until(read_deadline)
            else:
                metadata = store.read()
            initial_read = False
            if metadata.started_at is None:
                raise RuntimeError("Workflow start is unavailable")
            prior = read_claim(metadata, connection)
            previous_job = None
            operation = "Check the previous Airbyte job"
            if prior is not None and (
                prior.workflow_started_at == metadata.started_at
                or (
                    prior.outcome not in {"rejected", "unconfirmed", "pod_too_large", "capacity_wait_exceeded"}
                    and not finished_job(url, prior, strict=capacity_enabled and workflow_read_seconds is None)
                )
            ):
                recovered = recover(url, prior, trigger_receipt)
                if prior.workflow_started_at == metadata.started_at or recovered.outcome != "unconfirmed":
                    result = recovered.model_copy(update={"workflow_started_at": metadata.started_at})
                    return save_receipt(store, prior, result) if result != prior else result
                previous_job = prior.previous_job

            attempt = next_attempt(metadata, prior, capacity=capacity_enabled)
            if capacity_enabled and capacity is None:
                capacity = Admission(store)
            wait = capacity_wait(metadata, attempt) if capacity is not None else None
            wait_deadline = (
                wait.deadline(capacity.settings.wait_limit_seconds)
                if capacity is not None and wait is not None
                else None
            )
            if wait_deadline is not None and datetime.now(UTC) >= wait_deadline:
                now = time.time()
                stopped = Launch(
                    workflow_uid=metadata.uid,
                    workflow_started_at=metadata.started_at,
                    attempt=attempt,
                    connection=connection,
                    previous_job=0,
                    deadline=now + window,
                    read_deadline=now + unreadable_window,
                    outcome="capacity_wait_exceeded",
                    outcome_at=wait_deadline,
                )
                operation = "Record the capacity wait timeout"
                try:
                    write_claim(store, metadata, stopped, wait, None)
                except urllib.error.HTTPError as error:
                    if error.code != 409:
                        raise
                    conflicts += 1
                    continue
                return stopped

            operation = "Acquire the capacity Lease"
            lease = capacity.lease.take() if capacity is not None else None
            if capacity is not None and lease is None:
                outage.missed(started, operation, LeaseLost("The capacity Lease is held."))
                continue

            with lease if lease is not None else nullcontext():
                operation = "Read Airbyte credentials"
                token = oauth_token()
                operation = "Prepare the Airbyte sync"
                previous_job = prepare(url, token, connection, previous_job, sizes)
                estimated = None
                placement = Capacity.FITS
                if capacity is not None:
                    operation = "Estimate the Airbyte pod request"
                    estimated = estimate(AirbyteResources(request, url), token, connection, capacity.settings.requests)
                    operation = "Check the capacity of the cluster"
                    placement = capacity.placement(estimated)
                if placement is not Capacity.WAIT:
                    if lease is not None and placement is Capacity.FITS:
                        operation = "Check the Lease submission budget"
                        lease.ensure_held(CLAIM_WRITE_TIMEOUT_SECONDS + REQUEST_TIMEOUT_SECONDS)
                    if wait_deadline is not None and datetime.now(UTC) >= wait_deadline:
                        continue
                    now = time.time()
                    claim = Launch(
                        workflow_uid=metadata.uid,
                        workflow_started_at=metadata.started_at,
                        attempt=attempt,
                        connection=connection,
                        previous_job=previous_job,
                        deadline=now + window,
                        read_deadline=now + unreadable_window,
                        estimated_pod_request=estimated,
                    )
                    if placement is Capacity.TOO_LARGE:
                        claim = claim.model_copy(update={"outcome": "pod_too_large", "outcome_at": datetime.now(UTC)})
                    operation = "Write the Workflow launch claim"
                    try:
                        write_claim(store, metadata, claim, wait, lease)
                    except urllib.error.HTTPError as error:
                        if error.code != 409:
                            raise
                        conflicts += 1
                        continue
                    if placement is Capacity.TOO_LARGE:
                        return claim
                    claim_written = True
                    observation_deadline = time.monotonic() + POD_OBSERVATION_SECONDS
                    result = send(url, token, claim)
                    if result.outcome == "pending":
                        result = confirm(url, claim)
                    if capacity is not None and lease is not None:
                        result = observe_launch(result, capacity, lease, observation_deadline)
                    return save_receipt(store, claim, result)

            operation = "Record the Workflow capacity wait"
            try:
                wait = start_wait(store, metadata, attempt)
            except urllib.error.HTTPError as error:
                if error.code != 409:
                    raise
                conflicts += 1
                continue
            if capacity is not None and wait is not None:
                wait_deadline = wait.deadline(capacity.settings.wait_limit_seconds)
            outage.progressed()
            if lease is not None and (error := lease.error) is not None:
                if not (isinstance(error, LeaseLost) or transient_error(error)):
                    raise error
                insight_logging.configure("airbyte-sync").warning(
                    "The Airbyte capacity Lease operation did not complete.", extra={"error_type": type(error).__name__}
                )
        except (CapacityUnreadable, WorkflowReadTimeout):
            raise
        except OSError as error:
            if claim_written or (initial_read and workflow_read_seconds is not None):
                raise
            if not capacity_enabled or not (isinstance(error, LeaseLost) or transient_error(error)):
                raise
            outage.missed(started, operation, error)
        else:
            delay = CHECK_INTERVAL_SECONDS
            if wait_deadline is not None:
                delay = min(delay, max(0, (wait_deadline - datetime.now(UTC)).total_seconds()))
            time.sleep(delay)

    raise RuntimeError("The Workflow launch claim write conflicted.")


def workflow_launch(
    url: str, trigger_receipt: Launch | None = None, *, workflow_read_seconds: int | None = None
) -> Launch:
    connection = UUID(os.environ["CONNECTION_ID"])
    window = int(os.environ["LAUNCH_CONFIRMATION_SECONDS"])
    unreadable_window = int(os.environ["LAUNCH_UNREADABLE_SECONDS"])
    if min(window, unreadable_window) <= 0:
        raise ValueError("Airbyte launch windows must be positive")
    sizes = parse(Sizes, os.environ["SYNC_RESOURCES"]) if "SYNC_RESOURCES" in os.environ else None
    store = WorkflowLaunch()
    return launch(
        store,
        url,
        connection,
        window,
        unreadable_window,
        trigger_receipt,
        workflow_read_seconds=workflow_read_seconds,
        sizes=sizes,
        capacity_enabled=capacity_check_enabled(),
    )


def report_launch(result: Launch) -> int:
    log = insight_logging.configure("airbyte-sync")
    if path := os.environ.get("AIRBYTE_LAUNCH_EVIDENCE_PATH"):
        try:
            Path(path).write_text(result.mark_json())
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
        case "pod_too_large":
            log.error("The Airbyte pod request exceeds the capacity of every eligible node.")
            return POD_TOO_LARGE
        case "capacity_wait_exceeded":
            log.error("The Airbyte capacity wait reached its time limit.")
            return CAPACITY_WAIT_EXCEEDED
        case "accepted":
            return 0
        case "pending":
            return 1


def main() -> int:
    log = insight_logging.configure("airbyte-sync")
    try:
        result = workflow_launch(airbyte_api_url())
        exit_code = report_launch(result)
    except CapacityUnreadable as error:
        log.error(str(error), extra=error.log_fields)
        return UNREADABLE
    except CapacityConfigurationError as error:
        log.error("The Airbyte capacity check stopped.", extra={"detail": str(error)})
        return CAPACITY_CONFIGURATION
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
