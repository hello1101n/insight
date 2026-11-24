from __future__ import annotations

import os
import time
import urllib.error
import urllib.parse
from collections.abc import Iterator
from datetime import UTC, datetime
from uuid import UUID

import insight_logging
from airbyte_estimate import Settings
from airbyte_launch import CAPACITY_WAIT, CapacityWait, Launch, WorkflowLaunch, WorkflowMetadata
from airbyte_resources import Response, parse
from api_response import transient_error
from capacity_lease import API_TIMEOUT_SECONDS, CapacityConfigurationError, HeldLease, Kubernetes, LeaseClient
from pod_capacity import Node, Pod, PodRequest, fits
from pydantic import Field

CHECK_INTERVAL_SECONDS = 15
POD_INTERVAL_SECONDS = 5
POD_OBSERVATION_SECONDS = 120


class ListMetadata(Response):
    token: str = Field(default="", alias="continue")


class Page[Item](Response):
    metadata: ListMetadata = ListMetadata()
    items: tuple[Item, ...]


class Admission:
    def __init__(self, store: WorkflowLaunch) -> None:
        self.api = Kubernetes(store.context, store.token)
        try:
            self.namespace = os.environ["AIRBYTE_AUTH_SECRET_NAMESPACE"]
            self.lease = LeaseClient(
                self.api, os.environ["WORKFLOW_NAMESPACE"], os.environ["POD_UID"], os.environ["AIRBYTE_CAPACITY_LEASE"]
            )
            self.settings = parse(Settings, os.environ["AIRBYTE_CAPACITY_SETTINGS"])
            self.settings.requests.validate_quantities()
        except (KeyError, ValueError) as error:
            raise CapacityConfigurationError("The Airbyte capacity settings are invalid.") from error

    def _list[Item](
        self, path: str, model: type[Page[Item]], labels: str = "", *, deadline: float | None = None
    ) -> Iterator[Item]:
        query = {"limit": "500"}
        if labels:
            query["labelSelector"] = labels
        while True:
            timeout = API_TIMEOUT_SECONDS if deadline is None else min(API_TIMEOUT_SECONDS, deadline - time.monotonic())
            if timeout <= 0:
                raise PodObservationTimeout
            page = self.api.read(f"{path}?{urllib.parse.urlencode(query)}", model, timeout=timeout)
            if deadline is not None and time.monotonic() >= deadline:
                raise PodObservationTimeout
            yield from page.items
            if not page.metadata.token:
                return
            query["continue"] = page.metadata.token

    def fits(self, request: PodRequest) -> bool:
        nodes = self._list("/api/v1/nodes", Page[Node])
        pods = self._list("/api/v1/pods", Page[Pod])
        return fits(request, nodes, pods, self.namespace, self.settings.node_selector)

    def job_request(self, connection: UUID, job: int, deadline: float) -> PodRequest | None:
        labels = f"job_id={job},connection_id={connection}"
        path = f"/api/v1/namespaces/{self.namespace}/pods"
        candidates = (
            (attempt, pod)
            for pod in self._list(path, Page[Pod], labels, deadline=deadline)
            if (attempt := replication_attempt(pod, job)) is not None
        )
        match = min(candidates, key=lambda candidate: candidate[0], default=None)
        return match[1].request() if match is not None else None

    def observe(self, launch: Launch, lease: HeldLease, deadline: float) -> PodRequest | None:
        if launch.job_id is None:
            return None
        last_error = None
        while time.monotonic() < deadline:
            if lease.error is not None:
                raise lease.error
            try:
                request = self.job_request(launch.connection, launch.job_id, deadline)
                if request is not None:
                    return request
                last_error = None
            except PodObservationTimeout:
                break
            except OSError as error:
                if not transient_error(error):
                    raise
                last_error = error

            delay = max(0, min(POD_INTERVAL_SECONDS, deadline - time.monotonic()))
            if lease.lost.is_set():
                time.sleep(delay)
            else:
                lease.lost.wait(delay)
        if last_error is not None:
            raise last_error
        return None


class PodObservationTimeout(TimeoutError):
    pass


class CapacityUnreadable(TimeoutError):
    def __init__(self, operation: str, error: OSError) -> None:
        super().__init__("The Airbyte capacity check reached its outage limit.")
        detail = f"HTTP {error.code}" if isinstance(error, urllib.error.HTTPError) else str(error)
        self.log_fields = {"operation": operation, "detail": detail or type(error).__name__}


class CheckOutage:
    def __init__(self, seconds: int) -> None:
        self.seconds = seconds
        self.since: float | None = None

    def missed(self, started: float, operation: str, error: OSError) -> None:
        if self.since is None:
            self.since = started
        deadline = self.since + self.seconds
        remaining = deadline - time.monotonic()
        failure = CapacityUnreadable(operation, error)
        if remaining <= 0:
            raise failure
        insight_logging.configure("airbyte-sync").warning(
            "The Airbyte capacity check made no progress.", extra=failure.log_fields
        )
        time.sleep(min(CHECK_INTERVAL_SECONDS, remaining))
        if time.monotonic() >= deadline:
            raise failure

    def progressed(self) -> None:
        self.since = None


def replication_attempt(pod: Pod, job: int) -> int | None:
    attempt = pod.metadata.labels.get("attempt_id", "")
    if not attempt.isascii() or not attempt.isdecimal():
        return None
    if (
        pod.metadata.labels.get("sync_step") == "replication"
        or pod.metadata.name == f"replication-job-{job}-attempt-{attempt}"
    ):
        return int(attempt)
    return None


def read_wait(metadata: WorkflowMetadata) -> CapacityWait | None:
    raw = metadata.annotations.get(CAPACITY_WAIT)
    if raw is None:
        return None
    wait = parse(CapacityWait, raw)
    if wait.workflow_uid != metadata.uid:
        return None
    return wait


def capacity_wait(metadata: WorkflowMetadata, attempt: int) -> CapacityWait | None:
    wait = read_wait(metadata)
    if wait is not None and (wait.workflow_started_at, wait.attempt) == (metadata.started_at, attempt):
        return wait
    return None


def next_attempt(metadata: WorkflowMetadata, prior: Launch | None, *, capacity: bool) -> int:
    attempt = prior.attempt + 1 if prior is not None else 1
    wait = read_wait(metadata) if capacity else None
    if wait is not None:
        offset = int(wait.workflow_started_at != metadata.started_at)
        attempt = max(attempt, wait.attempt + offset)
    return attempt


def start_wait(store: WorkflowLaunch, metadata: WorkflowMetadata, attempt: int) -> None:
    if metadata.started_at is None or capacity_wait(metadata, attempt) is not None:
        return
    wait = CapacityWait(
        workflow_uid=metadata.uid,
        workflow_started_at=metadata.started_at,
        attempt=attempt,
        started_at=max(metadata.started_at, datetime.now(UTC)),
    )
    store.write_annotations(metadata, {CAPACITY_WAIT: wait.model_dump_json()})
