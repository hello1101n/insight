from __future__ import annotations

import json
import sys
import urllib.error
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import airbyte_sync_trigger as trigger
import pytest
from airbyte_launch import ANNOTATION, Launch, WorkflowMetadata

CONNECTION = UUID("12345678-1234-1234-1234-123456789abc")
UID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
START = datetime(2026, 1, 1, tzinfo=UTC)
BASE = "https://airbyte.example.com"


@dataclass
class Workflow:
    value: Launch | None = None
    version: int = 1
    uid: UUID = UID
    started_at: datetime = START
    write_errors: list[int | None] = field(default_factory=list)

    def read(self) -> WorkflowMetadata:
        annotations = {ANNOTATION: self.value.model_dump_json()} if self.value is not None else {}
        return WorkflowMetadata(
            uid=self.uid, resourceVersion=str(self.version), annotations=annotations, started_at=self.started_at
        )

    def write(self, metadata: WorkflowMetadata, value: Launch) -> None:
        if self.write_errors and (code := self.write_errors.pop(0)) is not None:
            self.version += 1
            raise http_error(code)
        assert metadata.version == str(self.version)
        self.version += 1
        self.value = value


def http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(BASE, code, "fixture", {}, None)


@pytest.fixture(autouse=True)
def token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(trigger, "oauth_token", lambda: "fixture")


@pytest.mark.parametrize("code", [400, 401, 404, 422])
def test_definitive_rejection_is_saved_without_a_second_send(monkeypatch: pytest.MonkeyPatch, code: int) -> None:
    workflow = Workflow()
    monkeypatch.setattr(trigger, "jobs", lambda *_: (19,))
    sends = []

    def response(url: str, _token: str, body: bytes) -> bytes:
        sends.append((url, body))
        raise http_error(code)

    monkeypatch.setattr(trigger, "request", response)
    assert trigger.launch(workflow, BASE, CONNECTION, 600, 1800).outcome == "rejected"
    assert trigger.launch(workflow, BASE, CONNECTION, 600, 1800).outcome == "rejected"
    assert len(sends) == 1


@pytest.mark.parametrize(
    "response",
    [http_error(408), http_error(429), http_error(503), TimeoutError(), ConnectionRefusedError(), b"{", b"{}"],
    ids=["408", "429", "503", "timeout", "refused", "bad-json", "wrong-shape"],
)
def test_unknown_reply_attaches_to_the_one_new_job(monkeypatch: pytest.MonkeyPatch, response: OSError | bytes) -> None:
    workflow = Workflow()
    reads = iter([(19,), (20, 19)])
    sends = []
    monkeypatch.setattr(trigger, "jobs", lambda *_: next(reads))

    def send(url: str, _token: str, body: bytes) -> bytes:
        sends.append((url, body))
        if isinstance(response, OSError):
            raise response
        return response

    monkeypatch.setattr(trigger, "request", send)
    assert trigger.launch(workflow, BASE, CONNECTION, 600, 1800).job_id == 20
    assert workflow.value is not None and workflow.value.outcome == "accepted"
    assert len(sends) == 1


def test_replacement_after_pod_death_recovers_the_prior_send(monkeypatch: pytest.MonkeyPatch) -> None:
    workflow = Workflow()
    reads = iter([(19,), (20, 19)])
    monkeypatch.setattr(trigger, "jobs", lambda *_: next(reads))
    sends = []

    def send(url: str, _token: str, body: bytes) -> bytes:
        sends.append((url, body))
        assert workflow.value is not None and workflow.value.previous_job == 19
        msg = "pod stopped"
        raise SystemExit(msg)

    monkeypatch.setattr(trigger, "request", send)
    with pytest.raises(SystemExit, match="pod stopped"):
        trigger.launch(workflow, BASE, CONNECTION, 600, 1800)
    assert trigger.launch(workflow, BASE, CONNECTION, 600, 1800).job_id == 20
    assert len(sends) == 1


def test_confirmation_expires_only_after_a_readable_list(monkeypatch: pytest.MonkeyPatch) -> None:
    claim = receipt(deadline=10, read_deadline=60)
    workflow = Workflow(claim)
    readings = iter([TimeoutError(), (19,)])
    sleeps = []

    def jobs(*_args: object) -> tuple[int, ...]:
        value = next(readings)
        if isinstance(value, TimeoutError):
            raise value
        return value

    monkeypatch.setattr(trigger, "jobs", jobs)
    monkeypatch.setattr(trigger.time, "time", lambda: 20)
    monkeypatch.setattr(trigger.time, "sleep", sleeps.append)
    assert trigger.launch(workflow, BASE, CONNECTION, 600, 1800).outcome == "unconfirmed"
    assert sleeps == [trigger.POLL_INTERVAL_SECONDS]


def receipt(**values: object) -> Launch:
    fields = dict(
        workflow_uid=UID,
        workflow_started_at=START,
        connection=CONNECTION,
        previous_job=19,
        deadline=600,
        read_deadline=1800,
    )
    return Launch.model_validate(fields | values)


@pytest.mark.parametrize("outcome", ["accepted", "rejected", "unconfirmed"])
def test_resubmitted_workflow_claims_its_own_launch(monkeypatch: pytest.MonkeyPatch, outcome: str) -> None:
    previous = receipt(outcome=outcome, job_id=19 if outcome == "accepted" else None)
    workflow = Workflow(previous, uid=UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"))
    sends = []
    monkeypatch.setattr(trigger, "jobs", lambda *_: (19,))
    monkeypatch.setattr(trigger, "request", lambda *args: sends.append(args) or b'{"job":{"id":20}}')

    result = trigger.launch(workflow, BASE, CONNECTION, 600, 1800)
    assert result.workflow_uid == workflow.uid
    assert result.job_id == 20
    assert len(sends) == 1


@pytest.mark.parametrize(
    ("outcome", "native", "expected"),
    [
        ("rejected", None, 20),
        ("unconfirmed", None, 20),
        ("accepted", "failed", 20),
        ("accepted", "running", 19),
        ("pending", None, 20),
        ("unreadable", None, 20),
    ],
)
def test_manual_retry_sends_only_after_a_known_outcome(
    monkeypatch: pytest.MonkeyPatch, outcome: str, native: str | None, expected: int
) -> None:
    previous = receipt(outcome=outcome, job_id=19 if outcome == "accepted" else None)
    workflow = Workflow(previous, started_at=START + timedelta(seconds=1))
    sends = []
    monkeypatch.setattr(trigger, "jobs", lambda *_: (20, 19) if outcome in {"pending", "unreadable"} else (19,))

    def answer(url: str, _token: str, _body: bytes) -> bytes:
        if url.endswith("/jobs/get"):
            return json.dumps(
                {"job": {"id": 19, "configId": str(CONNECTION), "configType": "sync", "status": native}}
            ).encode()
        sends.append(url)
        return b'{"job":{"id":20}}'

    monkeypatch.setattr(trigger, "request", answer)
    fresh = outcome in {"rejected", "unconfirmed"} or native == "failed"
    result = trigger.launch(workflow, BASE, CONNECTION, 600, 1800)
    assert len(sends) == int(fresh)
    assert result.job_id == expected
    assert result.attempt == (2 if fresh else 1)
    assert result.workflow_started_at == workflow.started_at


def test_claim_conflict_reads_the_new_version_before_sending(monkeypatch: pytest.MonkeyPatch) -> None:
    workflow = Workflow(write_errors=[409])
    monkeypatch.setattr(trigger, "jobs", lambda *_: (19,))
    sends = []

    def answer(url: str, _token: str, _body: bytes) -> bytes:
        assert workflow.value is not None and workflow.version == 3
        sends.append(url)
        return b'{"job":{"id":20}}'

    monkeypatch.setattr(trigger, "request", answer)
    assert trigger.launch(workflow, BASE, CONNECTION, 600, 1800).job_id == 20
    assert len(sends) == 1


@pytest.mark.parametrize("failures", [1, trigger.WRITE_ATTEMPTS])
def test_rejection_survives_receipt_write_failures(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, failures: int
) -> None:
    workflow = Workflow(write_errors=[None, *([503] * failures)])
    evidence = tmp_path / "evidence"
    monkeypatch.setenv("AIRBYTE_LAUNCH_EVIDENCE_PATH", str(evidence))
    monkeypatch.setattr(trigger, "jobs", lambda *_: (19,))

    def reject(*_args: object) -> bytes:
        raise http_error(400)

    monkeypatch.setattr(trigger, "request", reject)
    result = trigger.launch(workflow, BASE, CONNECTION, 600, 1800)
    assert trigger.report_launch(result) == trigger.REJECTED
    assert Launch.model_validate_json(evidence.read_bytes()).outcome == "rejected"
    assert workflow.value is not None
    assert workflow.value.outcome == ("pending" if failures == trigger.WRITE_ATTEMPTS else "rejected")


def test_unreadable_job_list_stops_at_its_deadline_without_a_second_send(monkeypatch: pytest.MonkeyPatch) -> None:
    workflow = Workflow()
    elapsed = 0
    reads = 0
    sends = []

    def jobs(*_args: object) -> tuple[int, ...]:
        nonlocal reads
        reads += 1
        if reads == 1:
            return (19,)
        raise TimeoutError

    def send(url: str, _token: str, _body: bytes) -> bytes:
        sends.append(url)
        raise TimeoutError

    def sleep(seconds: int) -> None:
        nonlocal elapsed
        elapsed += seconds
        assert elapsed <= 15, "confirmation exceeded its unreadable deadline"

    monkeypatch.setattr(trigger, "jobs", jobs)
    monkeypatch.setattr(trigger, "request", send)
    monkeypatch.setattr(trigger.time, "time", lambda: elapsed)
    monkeypatch.setattr(trigger.time, "sleep", sleep)
    for _ in range(2):
        result = trigger.launch(workflow, BASE, CONNECTION, 5, 15)
        assert result.outcome == "unreadable"
    assert elapsed == 15
    assert len(sends) == 1


def test_poll_cannot_attach_the_previous_attempts_job_to_a_new_claim(monkeypatch: pytest.MonkeyPatch) -> None:
    current = receipt(attempt=2, previous_job=20)
    stale = receipt(outcome="accepted", job_id=20)
    workflow = Workflow(current)
    monkeypatch.setattr(trigger, "jobs", lambda *_: (21, 20))
    result = trigger.launch(workflow, BASE, CONNECTION, 600, 1800, stale)
    assert result.attempt == 2
    assert result.job_id == 21


def test_manual_retry_launches_once_when_the_unreadable_claim_is_confirmed_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    workflow = Workflow(receipt(outcome="unreadable"), started_at=START + timedelta(hours=1))
    sends = []
    monkeypatch.setattr(trigger.time, "time", lambda: 3600)
    monkeypatch.setattr(trigger, "jobs", lambda *_: (19,))

    def send(url: str, _token: str, _body: bytes) -> bytes:
        assert url.endswith("/connections/sync")
        assert workflow.value is not None and workflow.value.outcome == "pending"
        sends.append(workflow.value.attempt)
        return b'{"job":{"id":20}}'

    monkeypatch.setattr(trigger, "request", send)
    result = trigger.launch(workflow, BASE, CONNECTION, 600, 1800)
    assert sends, f"argo retry after an unreadable list ended {result.outcome} without launching"
    assert result.job_id == 20
    assert result.attempt == 2
    assert trigger.launch(workflow, BASE, CONNECTION, 600, 1800) == result
    assert sends == [2]
