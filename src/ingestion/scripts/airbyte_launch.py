from __future__ import annotations

import json
import os
import ssl
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Literal, Self
from uuid import UUID

from api_response import capacity_check_enabled, parse_response, response_errors, transient_error
from pod_capacity import PodRequest
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, PositiveInt, model_validator

ANNOTATION = "insight.cyberfabric.com/airbyte-launch"
CAPACITY_WAIT = "insight.cyberfabric.com/airbyte-capacity-wait"
REQUEST_TIMEOUT_SECONDS = 30
MAX_READ_BACKOFF_SECONDS = 30
CLAIM_WRITE_TIMEOUT_SECONDS = 5


class WorkflowReadTimeout(TimeoutError):
    pass


class Launch(BaseModel):
    model_config = ConfigDict(frozen=True, populate_by_name=True)

    workflow_uid: UUID
    workflow_started_at: datetime
    attempt: PositiveInt = 1
    connection: UUID
    previous_job: int = Field(ge=0)
    deadline: float
    read_deadline: float
    outcome: Literal["pending", "accepted", "rejected", "unconfirmed", "unreadable"] = "pending"
    job_id: PositiveInt | None = None
    outcome_at: datetime | None = None
    estimated_pod_request: PodRequest | None = None
    pod_request: PodRequest | None = None

    def mark_json(self) -> str:
        omitted = {field for field in ("estimated_pod_request", "pod_request") if getattr(self, field) is None}
        return self.model_dump_json(exclude=omitted)

    @model_validator(mode="after")
    def validate_receipt(self) -> Self:
        if (self.outcome == "accepted") != (self.job_id is not None):
            raise ValueError("Launch outcome and job identifier disagree")
        return self


class CapacityWait(BaseModel):
    model_config = ConfigDict(frozen=True)

    workflow_uid: UUID
    workflow_started_at: AwareDatetime
    attempt: PositiveInt
    started_at: AwareDatetime
    ended_at: AwareDatetime | None = None

    @model_validator(mode="after")
    def validate_interval(self) -> Self:
        if self.started_at < self.workflow_started_at or (
            self.ended_at is not None and self.ended_at < self.started_at
        ):
            raise ValueError("The capacity wait timestamps are out of order.")
        return self


class WorkflowMetadata(BaseModel):
    model_config = ConfigDict(frozen=True)

    uid: UUID
    version: str = Field(alias="resourceVersion")
    annotations: dict[str, str] = Field(default_factory=dict)
    started_at: datetime | None = None


class WorkflowStatus(BaseModel):
    model_config = ConfigDict(frozen=True)

    started_at: datetime = Field(alias="startedAt")


class Workflow(BaseModel):
    model_config = ConfigDict(frozen=True)

    metadata: WorkflowMetadata
    status: WorkflowStatus


class WorkflowLaunch:
    def __init__(self) -> None:
        namespace = os.environ["WORKFLOW_NAMESPACE"]
        name = os.environ["WORKFLOW_NAME"]
        self.uid = UUID(os.environ["WORKFLOW_UID"])
        self.url = f"https://kubernetes.default.svc/apis/argoproj.io/v1alpha1/namespaces/{namespace}/workflows/{name}"
        sa = Path("/var/run/secrets/kubernetes.io/serviceaccount")
        self.context = ssl.create_default_context(cafile=sa / "ca.crt")
        self.token = sa / "token"

    def _request(self, patch: dict | None = None, *, timeout: float = REQUEST_TIMEOUT_SECONDS) -> WorkflowMetadata:
        data = json.dumps(patch).encode() if patch is not None else None
        request = urllib.request.Request(
            self.url,
            data=data,
            method="PATCH" if patch is not None else "GET",
            headers={
                "Authorization": f"Bearer {self.token.read_text().strip()}",
                "Content-Type": "application/merge-patch+json",
            },
        )
        enabled = capacity_check_enabled()
        errors = response_errors(enabled=enabled)
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with errors, urllib.request.urlopen(request, timeout=timeout, context=self.context) as response:
            workflow = parse_response(Workflow, response.read(), enabled=enabled)
        metadata = workflow.metadata.model_copy(update={"started_at": workflow.status.started_at})
        if metadata.uid != self.uid:
            raise RuntimeError("Workflow UID changed")
        return metadata

    def read(self) -> WorkflowMetadata:
        return self._request()

    def read_until(self, deadline: float) -> WorkflowMetadata:
        delay = 1
        enabled = capacity_check_enabled()
        while (remaining := deadline - time.monotonic()) > 0:
            try:
                return self._request(timeout=min(remaining, REQUEST_TIMEOUT_SECONDS))
            except urllib.error.HTTPError as error:
                if error.code not in (408, 429) and not 500 <= error.code < 600:
                    raise
            except OSError as error:
                if enabled and not transient_error(error):
                    raise
            time.sleep(max(0, min(delay, deadline - time.monotonic())))
            delay = min(delay * 2, MAX_READ_BACKOFF_SECONDS)
        raise WorkflowReadTimeout("The Workflow read outage reached its deadline")

    def write(self, metadata: WorkflowMetadata, launch: Launch, *, timeout: float = REQUEST_TIMEOUT_SECONDS) -> None:
        self.write_annotations(metadata, {ANNOTATION: launch.mark_json()}, timeout=timeout)

    def write_admitted(self, metadata: WorkflowMetadata, launch: Launch, wait: CapacityWait) -> None:
        self.write_annotations(
            metadata,
            {ANNOTATION: launch.mark_json(), CAPACITY_WAIT: wait.model_dump_json()},
            timeout=CLAIM_WRITE_TIMEOUT_SECONDS,
        )

    def write_annotations(
        self, metadata: WorkflowMetadata, annotations: dict[str, str], *, timeout: float = REQUEST_TIMEOUT_SECONDS
    ) -> None:
        self._request(
            {"metadata": {"uid": str(self.uid), "resourceVersion": metadata.version, "annotations": annotations}},
            timeout=timeout,
        )


def read_claim(metadata: WorkflowMetadata, connection: UUID) -> Launch | None:
    value = metadata.annotations.get(ANNOTATION)
    if value is None:
        return None
    launch = Launch.model_validate_json(value)
    if launch.workflow_uid != metadata.uid:
        return None
    if launch.connection != connection:
        raise RuntimeError("Workflow launch belongs to another connection")
    return launch
