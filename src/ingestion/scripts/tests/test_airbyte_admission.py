from __future__ import annotations

import io
import json
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http.client import IncompleteRead
from pathlib import Path
from threading import Event
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import airbyte_auth
import airbyte_sync_trigger as trigger
import capacity_lease
import pytest
from airbyte_launch import ANNOTATION, CAPACITY_WAIT, CapacityWait, Launch, WorkflowLaunch
from capacity_lease import Kubernetes, LeaseClient
from pod_capacity import PodRequest

UID = UUID(int=1)
CONNECTION = UUID(int=2)
SOURCE = UUID(int=3)
DESTINATION = UUID(int=4)
SOURCE_DEF = UUID(int=5)
DEST_DEF = UUID(int=6)
VERSION = "resourceVersion"
LEASE = "example-airbyte-capacity"
SETTINGS = json.dumps(
    {
        "nodeSelector": {"pool": "jobs"},
        "requests": {
            "orchestrator": {"cpu": "1", "memory": "2Gi"},
            "source": {"cpu": "1", "memory": "2Gi"},
            "destination": {"cpu": "500m", "memory": "1Gi"},
            "init": {"cpu": "1", "memory": "2Gi"},
        },
    }
)


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://example.com", code, "fixture", {}, None)


def job_pod(*, scheduled: str, name: str, labels: dict[str, str]) -> dict[str, object]:
    return {
        "metadata": {"name": name, "namespace": "example-airbyte", "labels": labels},
        "spec": {"containers": [{"resources": {"requests": {"cpu": "3575m", "memory": "5Gi"}}}]},
        "status": {"conditions": [{"type": "PodScheduled", "status": scheduled}]},
    }


@dataclass
class Fixture:
    events: list[str] = field(default_factory=list)
    nodes: Iterator[object] = field(default_factory=lambda: iter(()))
    pods: Iterator[list[dict[str, object]]] = field(default_factory=lambda: iter(()))
    workflow: dict[str, str] = field(default_factory=dict)
    lease: dict[str, object] = field(default_factory=dict)
    allocation: dict[str, object] = field(default_factory=dict)
    requirements: dict[str, object] = field(default_factory=dict)
    reads: dict[str, int] = field(default_factory=dict)
    workflow_version: int = 1
    lease_version: int = 1
    mode: str = "accepted"
    require_lease: bool = True
    hide_pod_while_leased: bool = False
    lease_error: int | None = None
    started_at: str = "2026-01-01T00:00:00Z"
    previous_jobs: tuple[int, ...] = (19,)
    job_id: int = 20

    def urlopen(self, request: urllib.request.Request, **_kwargs: object) -> io.BytesIO:
        target = urllib.parse.urlsplit(request.full_url)
        patch = json.loads(request.data) if request.data is not None else None
        path = target.path
        if path.endswith("/workflows/example"):
            if patch is not None:
                assert patch["metadata"][VERSION] == str(self.workflow_version)
                self.workflow_version += 1
                annotations = patch["metadata"]["annotations"]
                if CAPACITY_WAIT in annotations:
                    wait = CapacityWait.model_validate_json(annotations[CAPACITY_WAIT])
                    if wait.ended_at is None:
                        assert not self.lease.get("holderIdentity")
                        self.events.append("wait-start")
                    else:
                        self.events.append("wait-end")
                if ANNOTATION in annotations:
                    record = Launch.model_validate_json(annotations[ANNOTATION])
                    if record.outcome == "pending":
                        assert bool(self.lease.get("holderIdentity")) is self.require_lease
                    self.events.append(record.outcome)
                self.workflow.update(annotations)
            reply = {
                "metadata": {"uid": str(UID), VERSION: str(self.workflow_version), "annotations": self.workflow},
                "status": {"startedAt": self.started_at},
            }
        elif path.endswith(f"/leases/{LEASE}"):
            if self.lease_error is not None:
                code, self.lease_error = self.lease_error, None
                raise http_error(code)
            if patch is not None:
                if patch["metadata"][VERSION] != str(self.lease_version):
                    raise http_error(409)
                held = bool(self.lease.get("holderIdentity"))
                self.lease_version += 1
                self.lease = patch["spec"]
                if not self.lease.get("holderIdentity"):
                    self.events.append("release")
                else:
                    self.events.append("renew" if held else "take")
            reply = {"metadata": {VERSION: str(self.lease_version)}, "spec": self.lease}
        elif path == "/api/v1/nodes":
            assert self.lease.get("holderIdentity")
            self.events.append("nodes")
            memory = next(self.nodes, "16Gi")
            if isinstance(memory, Exception):
                raise memory
            reply = {
                "items": [
                    {
                        "metadata": {"name": "example", "labels": {"pool": "jobs"}},
                        "status": {
                            "allocatable": {"cpu": "8", "memory": memory},
                            "conditions": [{"type": "Ready", "status": "True"}],
                        },
                    }
                ]
            }
        elif path == "/api/v1/pods":
            assert self.lease.get("holderIdentity")
            self.events.append("pods")
            reply = {"items": next(self.pods, [])}
        elif path == "/api/v1/namespaces/example-airbyte/pods":
            query = urllib.parse.parse_qs(target.query)
            assert query["labelSelector"] == [f"job_id={self.job_id},connection_id={CONNECTION}"]
            self.events.append("job-pod")
            labels = {"job_id": str(self.job_id), "attempt_id": "0", "connection_id": str(CONNECTION)}
            observed_pod = job_pod(scheduled="False", name=f"replication-job-{self.job_id}-attempt-0", labels=labels)
            hidden = self.hide_pod_while_leased and self.lease.get("holderIdentity")
            reply = {"items": [] if hidden else [observed_pod]}
        else:
            raise AssertionError(path)
        return io.BytesIO(json.dumps(reply).encode())

    def airbyte(self, url: str, _token: str, body: bytes | None = None) -> bytes:
        path = url.split("/api/")[1].split("?")[0]
        self.reads[path] = self.reads.get(path, 0) + 1
        if path == "public/v1/jobs":
            jobs = (
                (self.job_id, self.previous_jobs[0])
                if self.mode == "lost" and "sync" in self.events
                else self.previous_jobs
            )
            return json.dumps(
                {"data": [{"jobId": job, "connectionId": str(CONNECTION), "jobType": "sync"} for job in jobs]}
            ).encode()
        if path == "v1/connections/sync":
            assert bool(self.lease.get("holderIdentity")) is self.require_lease
            assert Launch.model_validate_json(self.workflow[ANNOTATION]).outcome == "pending"
            self.events.append("sync")
            if self.mode == "rejected":
                raise http_error(422)
            if self.mode == "lost":
                raise http_error(503)
            return json.dumps({"job": {"id": self.job_id}}).encode()
        if path == "v1/jobs/get":
            job = json.loads(body or b"{}")["id"]
            return json.dumps(
                {"job": {"id": job, "configId": str(CONNECTION), "configType": "sync", "status": "failed"}}
            ).encode()
        if self.mode == "airbyte-read-error" and self.reads[path] == 1:
            raise http_error(503)
        if path == "v1/sources/partial_update":
            self.allocation = json.loads(body or b"{}")["resourceAllocation"]
            self.events.append("converge")
        source = {
            "sourceId": str(SOURCE),
            "sourceDefinitionId": str(SOURCE_DEF),
            "workspaceId": str(UUID(int=7)),
            "numConnections": 1,
            "resourceAllocation": self.allocation,
        }
        reply = {
            "v1/connections/get": {
                "connectionId": str(CONNECTION),
                "sourceId": str(SOURCE),
                "destinationId": str(DESTINATION),
                "resourceRequirements": self.requirements,
            },
            "v1/sources/get": source,
            "v1/sources/partial_update": source,
            "v1/destinations/get": {"destinationId": str(DESTINATION), "destinationDefinitionId": str(DEST_DEF)},
            "v1/source_definitions/get": {"sourceDefinitionId": str(SOURCE_DEF)},
            "v1/destination_definitions/get": {"destinationDefinitionId": str(DEST_DEF)},
        }[path]
        return json.dumps(reply).encode()

    def sleep(self, seconds: int) -> None:
        assert seconds == 15
        assert not self.lease.get("holderIdentity")
        self.events.append("sleep")


@pytest.fixture
def fixture(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Fixture:
    stub = Fixture()
    store = object.__new__(WorkflowLaunch)
    store.uid = UID
    store.url = "https://kubernetes.default.svc/apis/argoproj.io/v1alpha1/namespaces/example-app/workflows/example"
    store.context = ssl.create_default_context()
    store.token = tmp_path / "token"
    store.token.write_text("example-token")
    monkeypatch.setattr(urllib.request, "urlopen", stub.urlopen)
    monkeypatch.setattr(trigger, "WorkflowLaunch", lambda: store)
    monkeypatch.setattr(trigger, "oauth_token", lambda: "example-token")
    monkeypatch.setattr(trigger, "request", stub.airbyte)
    monkeypatch.setattr(trigger.time, "sleep", stub.sleep)
    for key, value in {
        "AIRBYTE_URL": "https://example.com",
        "WORKFLOW_NAMESPACE": "example-app",
        "AIRBYTE_AUTH_SECRET_NAMESPACE": "example-airbyte",
        "POD_UID": str(UUID(int=8)),
        "AIRBYTE_CAPACITY_CHECK_ENABLED": "true",
        "AIRBYTE_CAPACITY_SETTINGS": SETTINGS,
        "AIRBYTE_CAPACITY_LEASE": LEASE,
        "CONNECTION_ID": str(CONNECTION),
        "LAUNCH_CONFIRMATION_SECONDS": "600",
        "LAUNCH_UNREADABLE_SECONDS": "1800",
        "SYNC_RESOURCES": '{"airbyte_cpu_millis":1750,"airbyte_memory_bytes":3221225472}',
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("AIRBYTE_LAUNCH_EVIDENCE_PATH", raising=False)
    return stub


@pytest.mark.parametrize("mode", ["accepted", "lost"])
def test_fit_after_convergence_waits_outside_the_lease_and_records_the_pod(
    fixture: Fixture, mode: str, capsys: pytest.CaptureFixture[str]
) -> None:
    fixture.mode = mode
    fixture.nodes = iter(["5Gi", "4Gi", "5Gi", "6Gi"])
    assert trigger.main() == 0
    captured = capsys.readouterr()
    assert captured.out == "20\n"
    assert fixture.events == [
        "take",
        "converge",
        "nodes",
        "pods",
        "release",
        "wait-start",
        "sleep",
        "take",
        "nodes",
        "pods",
        "release",
        "sleep",
        "take",
        "nodes",
        "pods",
        "release",
        "sleep",
        "take",
        "nodes",
        "pods",
        "wait-end",
        "pending",
        "sync",
        "job-pod",
        "release",
        "accepted",
    ]
    wait = CapacityWait.model_validate_json(fixture.workflow[CAPACITY_WAIT])
    assert wait.attempt == 1 and wait.ended_at is not None and wait.ended_at >= wait.started_at
    result = Launch.model_validate_json(fixture.workflow[ANNOTATION])
    assert result.estimated_pod_request == PodRequest(cpu_millis=3250, memory_bytes=6 * 1024**3)
    assert result.pod_request == PodRequest(cpu_millis=3575, memory_bytes=5 * 1024**3)
    warnings = [json.loads(line) for line in captured.err.splitlines() if "differs from the estimate" in line]
    assert len(warnings) == 1
    assert warnings[0]["fields"]["estimated"] == result.estimated_pod_request.model_dump()
    assert warnings[0]["fields"]["actual"] == result.pod_request.model_dump()


@pytest.mark.parametrize("status", ["False", "Unknown", "missing"])
def test_unscheduled_airbyte_job_blocks_an_otherwise_fitting_launch(fixture: Fixture, status: str) -> None:
    blocker = job_pod(scheduled=status, name="example-job", labels={"airbyte": "job-pod"})
    if status == "missing":
        blocker["status"] = {}
    other_namespace = {
        **blocker,
        "metadata": {"name": "other", "namespace": "another", "labels": {"airbyte": "job-pod"}},
    }
    fixture.pods = iter([[blocker], [other_namespace]])
    assert trigger.main() == 0
    assert fixture.events.index("wait-start") < fixture.events.index("sleep") < fixture.events.index("sync")
    assert fixture.events.count("sync") == 1


@pytest.mark.parametrize("code", [403, 404])
def test_nodes_configuration_error_stops_without_a_launch(
    fixture: Fixture, code: int, capsys: pytest.CaptureFixture[str]
) -> None:
    fixture.nodes = iter([http_error(code)])
    assert trigger.main() == trigger.CAPACITY_CONFIGURATION
    assert "sync" not in fixture.events
    assert fixture.events[-1] == "release"
    log = capsys.readouterr().err.splitlines()
    assert len(log) == 1 and "/api/v1/nodes" in log[0] and f"HTTP {code}" in log[0]


@pytest.mark.parametrize("code", [403, 404])
def test_lease_configuration_error_stops_without_a_launch(
    fixture: Fixture, code: int, capsys: pytest.CaptureFixture[str]
) -> None:
    fixture.lease_error = code
    assert trigger.main() == trigger.CAPACITY_CONFIGURATION
    assert fixture.events == []
    log = capsys.readouterr().err.splitlines()
    assert len(log) == 1 and "/leases/" in log[0] and f"HTTP {code}" in log[0]


@pytest.mark.parametrize("which", ["kubernetes", "airbyte"])
def test_temporary_read_error_rechecks_after_releasing_the_lease(fixture: Fixture, which: str) -> None:
    if which == "kubernetes":
        fixture.nodes = iter([http_error(503)])
    else:
        fixture.mode = "airbyte-read-error"
    assert trigger.main() == 0
    assert fixture.events.index("release") < fixture.events.index("sleep") < fixture.events.index("sync")
    assert fixture.events.count("sync") == 1


def test_lease_releases_when_airbyte_rejects_before_creating_a_job(fixture: Fixture) -> None:
    fixture.mode = "rejected"
    assert trigger.main() == trigger.REJECTED
    assert fixture.events[-3:] == ["sync", "release", "rejected"]


def test_lease_expiry_uses_local_elapsed_time_for_an_unchanged_holder_and_renewal(
    fixture: Fixture, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = LeaseClient(
        Kubernetes(ssl.create_default_context(), tmp_path / "token"), "example-app", "replacement", LEASE
    )
    now = datetime.now(UTC)
    elapsed = 0

    def monotonic() -> float:
        return elapsed

    monkeypatch.setattr(capacity_lease.time, "monotonic", monotonic)
    fixture.lease = {
        "holderIdentity": "original",
        "leaseDurationSeconds": 45,
        "renewTime": (now - timedelta(days=1)).isoformat(),
    }
    assert client.take() is None
    assert fixture.events == []
    elapsed = 44
    assert client.take() is None
    fixture.lease["renewTime"] = (now + timedelta(days=1)).isoformat()
    elapsed = 45
    assert client.take() is None
    fixture.lease["holderIdentity"] = "another"
    elapsed = 88
    assert client.take() is None
    elapsed = 132
    fixture.lease_version += 1
    assert client.take() is None
    elapsed = 133
    lease = client.take()
    assert lease is not None
    with lease:
        assert fixture.lease["holderIdentity"] == "replacement"
        assert fixture.lease["leaseDurationSeconds"] <= 60
        lease.ensure_held()
    assert fixture.lease["holderIdentity"] is None


def test_lease_renews_while_held_and_releases_at_the_deadline(
    fixture: Fixture, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(capacity_lease, "RENEW_SECONDS", 0.02)
    monkeypatch.setattr(capacity_lease, "HOLD_SECONDS", 1.1)
    client = LeaseClient(Kubernetes(ssl.create_default_context(), tmp_path / "token"), "example-app", "original", LEASE)
    lease = client.take()
    assert lease is not None
    with lease:
        assert lease.lost.wait(1.2)
    assert "renew" in fixture.events
    assert fixture.events[-1] == "release"
    assert fixture.lease["holderIdentity"] is None


def test_disabled_switch_keeps_the_original_launch_calls(fixture: Fixture, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AIRBYTE_CAPACITY_CHECK_ENABLED", "false")
    monkeypatch.setenv("SYNC_RESOURCES", "{}")
    fixture.require_lease = False
    assert trigger.main() == 0
    assert fixture.events == ["pending", "sync", "accepted"]
    assert fixture.reads == {"public/v1/jobs": 1, "v1/connections/sync": 1}
    assert "estimated_pod_request" not in fixture.workflow[ANNOTATION]


def test_enabled_poll_can_claim_only_after_capacity_becomes_available(fixture: Fixture) -> None:
    fixture.nodes = iter(["4Gi", "6Gi"])
    result = trigger.workflow_launch("https://example.com", workflow_read_seconds=600)
    assert result.job_id == 20
    assert fixture.events.index("wait-start") < fixture.events.index("wait-end") < fixture.events.index("sync")
    assert fixture.events.count("sync") == 1


def test_a_pod_that_appears_after_the_lease_deadline_is_still_recorded(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture.hide_pod_while_leased = True
    monkeypatch.setattr(capacity_lease, "HOLD_SECONDS", 0.5)
    monkeypatch.setattr(trigger, "CLAIM_WRITE_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(trigger, "REQUEST_TIMEOUT_SECONDS", 0.05)
    assert trigger.main() == 0
    assert fixture.events[-4:] == ["job-pod", "release", "job-pod", "accepted"]
    result = Launch.model_validate_json(fixture.workflow[ANNOTATION])
    assert result.pod_request == PodRequest(cpu_millis=3575, memory_bytes=5 * 1024**3)


@pytest.mark.parametrize("failure", ["history", "allocation", "quantity", "wait", "interval", "http", "file"])
def test_permanent_admission_errors_fail_without_waiting(
    fixture: Fixture, failure: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    if failure == "history":
        fixture.previous_jobs = (19, 20)
    elif failure == "allocation":
        fixture.allocation = {
            "jobSpecific": [
                {"jobType": "sync", "resourceRequirements": {"cpu_request": "1"}},
                {"jobType": "sync", "resourceRequirements": {"cpu_request": "2"}},
            ]
        }
    elif failure == "quantity":
        monkeypatch.setenv("SYNC_RESOURCES", "{}")
        fixture.requirements = {"cpu_request": "invalid"}
    elif failure == "wait":
        fixture.workflow[CAPACITY_WAIT] = "not JSON"
    elif failure == "interval":
        fixture.workflow[CAPACITY_WAIT] = json.dumps(
            {
                "workflow_uid": str(UID),
                "workflow_started_at": fixture.started_at,
                "attempt": 1,
                "started_at": fixture.started_at,
                "ended_at": "2025-12-31T00:00:00Z",
            }
        )
    elif failure == "http":
        from airbyte_resources import AirbyteResources

        def bad_response(*_args: object) -> None:
            raise http_error(422)

        monkeypatch.setattr(AirbyteResources, "converge", bad_response)
    else:
        fixture.nodes = iter([FileNotFoundError("example")])

    def no_retry(_seconds: int) -> None:
        pytest.fail("a permanent capacity error retried")

    monkeypatch.setattr(trigger.time, "sleep", no_retry)
    assert trigger.main() == 1
    assert {"sync", "wait-start"}.isdisjoint(fixture.events)
    assert len(capsys.readouterr().err.splitlines()) == 1


@pytest.mark.parametrize("failure", ["HTTP 503", "connection", "timeout", "lease"])
def test_uninterrupted_missed_checks_stop_at_the_outage_limit(
    fixture: Fixture, failure: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    elapsed = 0.0
    delays = []
    monkeypatch.setenv("LAUNCH_UNREADABLE_SECONDS", "31")
    monkeypatch.setattr(trigger.time, "monotonic", lambda: elapsed)

    def sleep(seconds: float) -> None:
        nonlocal elapsed
        delays.append(seconds)
        elapsed += seconds
        assert elapsed <= 31, "the uninterrupted outage outlived its limit"

    monkeypatch.setattr(trigger.time, "sleep", sleep)
    if failure == "lease":
        fixture.lease = {"holderIdentity": "other", "leaseDurationSeconds": 45, "renewTime": fixture.started_at}
    else:
        error = {"HTTP 503": http_error(503), "connection": ConnectionResetError(), "timeout": TimeoutError()}[failure]
        fixture.nodes = iter([error] * 3)

    assert trigger.main() == trigger.UNREADABLE
    assert delays == [15, 15, 1]
    assert {"sync", "wait-start"}.isdisjoint(fixture.events)
    logs = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert sum("outage limit" in str(entry) for entry in logs) == 1


def test_successful_no_fit_check_resets_the_outage_limit(fixture: Fixture, monkeypatch: pytest.MonkeyPatch) -> None:
    fixture.nodes = iter([http_error(408), "4Gi", http_error(429), "6Gi"])
    elapsed = 0.0
    monkeypatch.setenv("LAUNCH_UNREADABLE_SECONDS", "20")
    monkeypatch.setattr(trigger.time, "monotonic", lambda: elapsed)

    def sleep(seconds: float) -> None:
        nonlocal elapsed
        elapsed += seconds

    monkeypatch.setattr(trigger.time, "sleep", sleep)
    assert trigger.main() == 0
    assert elapsed == 45
    assert fixture.events.count("wait-start") == fixture.events.count("wait-end") == 1


@pytest.mark.parametrize("failure", ["pod-list", "release", "renewal"])
def test_accepted_job_survives_measurement_and_lease_errors(
    fixture: Fixture, failure: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    renewal_failed = Event()
    original = fixture.urlopen
    monkeypatch.setattr(capacity_lease, "RENEW_SECONDS", 0.01)

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        path = urllib.parse.urlsplit(request.full_url).path
        if path == "/api/v1/namespaces/example-airbyte/pods":
            if failure == "pod-list":
                raise http_error(403)
            if failure == "renewal":
                assert renewal_failed.wait(1)
        if path.endswith(f"/leases/{LEASE}") and request.data is not None and "sync" in fixture.events:
            holder = json.loads(request.data)["spec"]["holderIdentity"]
            if failure == "release" and holder is None:
                raise http_error(403)
            if failure == "renewal" and holder:
                renewal_failed.set()
                raise http_error(403)
        return original(request, **kwargs)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    assert trigger.main() == 0
    result = Launch.model_validate_json(fixture.workflow[ANNOTATION])
    assert result.outcome == "accepted" and result.job_id == 20 and result.pod_request is None
    captured = capsys.readouterr()
    assert captured.out == "20\n"
    assert captured.err.count("The Airbyte pod request measurement did not complete.") == 1
    assert "differs from the estimate" not in captured.err


def test_transient_renewal_error_retries_before_the_lease_expires(
    fixture: Fixture, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = LeaseClient(Kubernetes(ssl.create_default_context(), tmp_path / "token"), "example-app", "original", LEASE)
    monkeypatch.setattr(capacity_lease, "RENEW_SECONDS", 0.01)
    monkeypatch.setattr(capacity_lease, "RENEW_RETRY_SECONDS", 0.01)
    lease = client.take()
    assert lease is not None
    fixture.lease_error = 503
    renewed = Event()
    original = fixture.urlopen

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        reply = original(request, **kwargs)
        if fixture.events[-1:] == ["renew"]:
            renewed.set()
        return reply

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    with lease:
        assert renewed.wait(1), "renewal stopped after one transient error"
        lease.ensure_held()
    assert fixture.events[-1] == "release"


def test_claim_waits_for_a_lease_that_covers_the_write_and_send(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monotonic = trigger.time.monotonic
    offset = 0
    lease = None
    original_open = fixture.urlopen
    original_take = LeaseClient.take
    monkeypatch.setattr(trigger.time, "monotonic", lambda: monotonic() + offset)

    def take(client: LeaseClient) -> capacity_lease.HeldLease | None:
        nonlocal lease
        lease = original_take(client)
        return lease

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        nonlocal offset
        reply = original_open(request, **kwargs)
        if urllib.parse.urlsplit(request.full_url).path == "/api/v1/pods" and fixture.events.count("take") == 1:
            offset = 90
            assert lease is not None
            lease.valid_until = lease.deadline
        return reply

    monkeypatch.setattr(LeaseClient, "take", take)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    assert trigger.main() == 0
    assert fixture.events.count("take") == 2
    assert fixture.events.count("pending") == fixture.events.count("sync") == 1


def test_lease_loss_after_claim_does_not_stop_submission(fixture: Fixture, monkeypatch: pytest.MonkeyPatch) -> None:
    lease = None
    original_check = capacity_lease.HeldLease.ensure_held
    original_open = fixture.urlopen

    def ensure_held(held: capacity_lease.HeldLease, *args: float) -> None:
        nonlocal lease
        lease = held
        original_check(held, *args)

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        reply = original_open(request, **kwargs)
        if fixture.events[-1:] == ["pending"]:
            assert lease is not None
            lease.valid_until = 0
        return reply

    monkeypatch.setattr(capacity_lease.HeldLease, "ensure_held", ensure_held)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    assert trigger.main() == 0
    assert fixture.events.count("sync") == 1
    assert Launch.model_validate_json(fixture.workflow[ANNOTATION]).outcome == "accepted"


def test_retry_after_a_wait_without_a_claim_uses_a_fresh_attempt(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture.nodes = iter(["4Gi", "4Gi", "6Gi"])

    class SimulatedStop(Exception):
        pass

    def stop(_seconds: float) -> None:
        raise SimulatedStop

    with monkeypatch.context() as stopping:
        stopping.setattr(trigger.time, "sleep", stop)
        with pytest.raises(SimulatedStop):
            trigger.main()
    old = CapacityWait.model_validate_json(fixture.workflow[CAPACITY_WAIT])
    assert old.attempt == 1 and old.ended_at is None and ANNOTATION not in fixture.workflow
    fixture.started_at = (old.started_at + timedelta(seconds=1)).isoformat()
    assert trigger.main() == 0
    wait = CapacityWait.model_validate_json(fixture.workflow[CAPACITY_WAIT])
    receipt = Launch.model_validate_json(fixture.workflow[ANNOTATION])
    assert wait.attempt == receipt.attempt == 2
    assert (
        wait.workflow_started_at == receipt.workflow_started_at and wait.workflow_started_at > old.workflow_started_at
    )
    assert wait.ended_at is not None
    assert fixture.events.count("wait-start") == 2 and fixture.events.count("wait-end") == 1


def test_pod_observation_does_not_run_past_120_seconds_from_submission(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = fixture.urlopen
    elapsed = 0.0
    requests = []

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        nonlocal elapsed
        if urllib.parse.urlsplit(request.full_url).path == "/api/v1/namespaces/example-airbyte/pods":
            requests.append((elapsed, kwargs["timeout"]))
            assert elapsed < 120, "pod observation exceeded 120 seconds"
            if len(requests) == 1:
                elapsed = 119
                return io.BytesIO(b'{"items":[]}')
            pytest.fail("another pod lookup started after the bounded wait")
        return original(request, **kwargs)

    def wait(_event: Event, seconds: float) -> bool:
        nonlocal elapsed
        elapsed += seconds
        assert elapsed == 120
        return False

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(trigger.time, "monotonic", lambda: elapsed)
    original_enter = capacity_lease.HeldLease.__enter__

    def enter(lease: capacity_lease.HeldLease) -> capacity_lease.HeldLease:
        monkeypatch.setattr(lease.lost, "wait", lambda seconds: wait(lease.lost, seconds))
        return original_enter(lease)

    monkeypatch.setattr(capacity_lease.HeldLease, "__enter__", enter)
    assert trigger.main() == 0
    assert elapsed == 120 and requests == [(0, 5)]
    assert Launch.model_validate_json(fixture.workflow[ANNOTATION]).pod_request is None


@pytest.mark.parametrize(
    ("fault", "applied", "can_send"),
    [
        (TimeoutError(), True, True),
        (ConnectionResetError(), True, True),
        (TimeoutError(), False, True),
        (TimeoutError(), True, False),
    ],
    ids=["applied-timeout", "applied-reset", "unapplied", "lease-expired"],
)
def test_uncertain_claim_write_sends_only_with_a_durable_claim_and_a_valid_lease(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch, fault: OSError, applied: bool, can_send: bool
) -> None:
    fixture.nodes = iter(["4Gi", "6Gi"])
    elapsed = 0.0
    failed = False
    original = fixture.urlopen
    monkeypatch.setattr(trigger.time, "time", lambda: elapsed)
    monotonic = trigger.time.monotonic
    monkeypatch.setattr(trigger.time, "monotonic", lambda: monotonic() + elapsed)

    def sleep(seconds: float) -> None:
        nonlocal elapsed
        elapsed += seconds
        assert elapsed <= 615

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        nonlocal failed, elapsed
        if not failed and request.full_url.endswith("/workflows/example") and request.data:
            patch = json.loads(request.data)
            annotations = patch.get("metadata", {}).get("annotations", {})
            if ANNOTATION in annotations:
                failed = True
                if applied:
                    original(request, **kwargs)
                if not can_send:
                    elapsed += 61
                raise fault
        return original(request, **kwargs)

    monkeypatch.setattr(trigger.time, "sleep", sleep)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    assert trigger.main() == (0 if can_send else trigger.UNCONFIRMED)
    assert fixture.events.count("pending") == 1
    assert fixture.events.count("sync") == int(can_send)
    assert fixture.events.count("wait-end") == 1


def test_retry_without_an_earlier_annotation_tracks_the_wait_for_its_execution(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    fixture.nodes = iter(["4Gi", "6Gi"])
    fixture.previous_jobs = (19, 20)
    assert trigger.main() == 1
    assert fixture.workflow == {}

    fixture.started_at = (datetime.fromisoformat(fixture.started_at) + timedelta(seconds=1)).isoformat()
    fixture.previous_jobs = (20, 19)
    fixture.job_id = 21

    def sleep(seconds: float) -> None:
        fixture.sleep(seconds)
        wait = CapacityWait.model_validate_json(fixture.workflow[CAPACITY_WAIT])
        assert (wait.workflow_started_at, wait.attempt, wait.ended_at) == (
            datetime.fromisoformat(fixture.started_at),
            1,
            None,
        )

    monkeypatch.setattr(trigger.time, "sleep", sleep)
    assert trigger.main() == 0
    wait = CapacityWait.model_validate_json(fixture.workflow[CAPACITY_WAIT])
    receipt = Launch.model_validate_json(fixture.workflow[ANNOTATION])
    assert (receipt.workflow_started_at, receipt.attempt) == (wait.workflow_started_at, wait.attempt)
    assert wait.ended_at is not None


@pytest.mark.parametrize(
    ("target", "fault"),
    [
        ("nodes", ssl.SSLEOFError()),
        ("nodes", urllib.error.URLError(socket.gaierror(socket.EAI_NONAME, "example"))),
        ("nodes", IncompleteRead(b"{}")),
        ("nodes", b'{"items":'),
        ("workflow", b'{"status":'),
        ("jobs", b'{"data":'),
        ("resources", b'{"connectionId":'),
        ("oauth", b'{"access_token":'),
    ],
    ids=["tls", "dns", "truncated-read", "nodes-body", "workflow-body", "jobs-body", "resources-body", "token-body"],
)
def test_unreadable_api_responses_retry_before_launch(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch, target: str, fault: OSError | bytes
) -> None:
    failed = False

    def body() -> bytes:
        nonlocal failed
        failed = True
        if isinstance(fault, Exception):
            raise fault
        return fault

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        path = urllib.parse.urlsplit(request.full_url).path
        if path.endswith("/applications/token"):
            return io.BytesIO(body() if not failed else b'{"access_token":"example-token"}')
        if not failed and (
            (target == "nodes" and path == "/api/v1/nodes")
            or (target == "workflow" and path.endswith("/workflows/example"))
        ):
            return io.BytesIO(body())
        return fixture.urlopen(request, **kwargs)

    def airbyte(url: str, token: str, payload: bytes | None = None) -> bytes:
        if not failed and (
            (target == "jobs" and "/api/public/v1/jobs?" in url)
            or (target == "resources" and url.endswith("/connections/get"))
        ):
            return body()
        return fixture.airbyte(url, token, payload)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(trigger, "request", airbyte)
    if target == "oauth":
        monkeypatch.setattr(airbyte_auth, "airbyte_creds", lambda: ("example", "example"))
        monkeypatch.setattr(trigger, "oauth_token", airbyte_auth.oauth_token)

    assert trigger.main() == 0
    assert fixture.events.count("sleep") == fixture.events.count("sync") == 1
    assert fixture.events.index("sleep") < fixture.events.index("sync")


@pytest.mark.parametrize("memory", ["4Gi", "6Gi"])
def test_successful_check_counts_after_the_outage_limit(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch, memory: str
) -> None:
    monotonic = trigger.time.monotonic
    elapsed = 0.0

    def nodes() -> Iterator[object]:
        nonlocal elapsed
        yield http_error(503)
        elapsed += 10
        yield memory
        yield "6Gi"

    def sleep(seconds: float) -> None:
        nonlocal elapsed
        assert seconds == 15
        elapsed += seconds

    fixture.nodes = nodes()
    monkeypatch.setenv("LAUNCH_UNREADABLE_SECONDS", "20")
    monkeypatch.setattr(trigger.time, "monotonic", lambda: monotonic() + elapsed)
    monkeypatch.setattr(trigger.time, "sleep", sleep)

    assert trigger.main() == 0
    assert fixture.events.count("sync") == 1
    assert fixture.events.count("wait-start") == int(memory == "4Gi")


@pytest.mark.parametrize("status", [503, 403])
def test_no_fit_records_the_wait_even_when_the_lease_release_fails(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    fixture.nodes = iter(["4Gi", "6Gi"])

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        result = fixture.urlopen(request, **kwargs)
        if (
            request.full_url.endswith(f"/leases/{LEASE}")
            and request.data
            and json.loads(request.data)["spec"]["holderIdentity"] is None
            and fixture.events.count("release") == 1
        ):
            raise http_error(status)
        return result

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    assert trigger.main() == (0 if status == 503 else trigger.CAPACITY_CONFIGURATION)
    assert fixture.events.count("wait-start") == 1
    assert fixture.events.index("release") < fixture.events.index("wait-start")


@pytest.mark.parametrize("fault", [408, 429, 500, 504, b'{"metadata":'], ids=["408", "429", "500", "504", "body"])
def test_applied_claim_with_a_transient_patch_response_sends_once(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch, fault: int | bytes
) -> None:
    elapsed = 0.0
    monkeypatch.setattr(trigger.time, "time", lambda: elapsed)

    def sleep(seconds: float) -> None:
        nonlocal elapsed
        elapsed += seconds

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        reply = fixture.urlopen(request, **kwargs)
        if request.get_method() == "PATCH" and request.full_url.endswith("/workflows/example"):
            saved = Launch.model_validate_json(fixture.workflow[ANNOTATION])
            if saved.outcome == "pending":
                if isinstance(fault, int):
                    raise http_error(fault)
                return io.BytesIO(fault)
        return reply

    monkeypatch.setattr(trigger.time, "sleep", sleep)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    assert trigger.main() == 0
    assert fixture.events.count("pending") == fixture.events.count("sync") == 1
    assert Launch.model_validate_json(fixture.workflow[ANNOTATION]).outcome == "accepted"


@pytest.mark.parametrize(
    ("failure", "operation", "error_detail"),
    [
        ("wait", "Record the Workflow capacity wait", "HTTP 503"),
        ("claim", "Write the Workflow launch claim", "HTTP 503"),
        ("lease", "Check the Lease submission budget", "The capacity Lease cannot cover submission."),
    ],
)
def test_admission_outage_limit_requires_progress(
    fixture: Fixture,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    failure: str,
    operation: str,
    error_detail: str,
) -> None:
    elapsed = 0.0
    monkeypatch.setenv("LAUNCH_UNREADABLE_SECONDS", "31")
    monkeypatch.setattr(trigger.time, "monotonic", lambda: elapsed)

    def sleep(seconds: float) -> None:
        nonlocal elapsed
        elapsed += seconds
        assert elapsed <= 31, f"{failure} exceeded the outage limit"

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        if request.get_method() == "PATCH" and request.full_url.endswith("/workflows/example"):
            raise http_error(500 + fixture.events.count("nodes"))
        return fixture.urlopen(request, **kwargs)

    def lose_lease(_lease: capacity_lease.HeldLease, minimum: float) -> None:
        assert minimum == 35
        raise capacity_lease.LeaseLost("The capacity Lease cannot cover submission.")

    if failure == "wait":
        fixture.nodes = iter(["4Gi"] * 4)
    if failure == "lease":
        monkeypatch.setattr(capacity_lease.HeldLease, "ensure_held", lose_lease)
    monkeypatch.setattr(trigger.time, "sleep", sleep)
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    assert trigger.main() == trigger.UNREADABLE
    assert elapsed == 31 and fixture.events.count("nodes") == 3
    assert fixture.workflow == {} and "sync" not in fixture.events
    logs = [json.loads(line)["fields"] for line in capsys.readouterr().err.splitlines()]
    expired = [entry for entry in logs if "outage limit" in entry["message"]]
    assert len(expired) == 1
    assert expired[0]["operation"] == operation and error_detail in expired[0]["detail"]


@pytest.mark.parametrize(
    "fault",
    [
        ssl.SSLCertVerificationError("example certificate error"),
        urllib.error.URLError(ssl.SSLCertVerificationError("example certificate error")),
        b'{"items":null}',
    ],
    ids=["certificate", "wrapped-certificate", "valid-json-wrong-shape"],
)
def test_permanent_capacity_api_errors_exit_without_retry(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch, fault: OSError | bytes
) -> None:
    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        if urllib.parse.urlsplit(request.full_url).path == "/api/v1/nodes":
            if isinstance(fault, OSError):
                raise fault
            return io.BytesIO(fault)
        return fixture.urlopen(request, **kwargs)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(trigger.time, "sleep", lambda _seconds: pytest.fail("a permanent API error retried"))

    assert trigger.main() == 1
    assert fixture.workflow == {} and "sync" not in fixture.events


def test_switch_off_missing_secret_data_reports_key_error(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "token").write_text("example-token")
    monkeypatch.setenv("AIRBYTE_CAPACITY_CHECK_ENABLED", "false")
    monkeypatch.setenv("AIRBYTE_AUTH_SECRET_NAME", "example")
    monkeypatch.setattr(airbyte_auth, "_SA_DIR", tmp_path)
    context = ssl.create_default_context()
    monkeypatch.setattr(ssl, "create_default_context", lambda **_kwargs: context)
    monkeypatch.setattr(trigger, "oauth_token", airbyte_auth.oauth_token)

    def urlopen(request: urllib.request.Request, **kwargs: object) -> io.BytesIO:
        if request.full_url.endswith("/secrets/example"):
            return io.BytesIO(b'{"metadata":{"name":"example"}}')
        return fixture.urlopen(request, **kwargs)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)

    assert trigger.main() == 1
    assert json.loads(capsys.readouterr().err)["fields"]["error_type"] == "KeyError"
    assert fixture.events == []
