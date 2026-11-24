from __future__ import annotations

import io
import json
import sys
import urllib.error
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import airbyte_sync_poll as poll
import airbyte_sync_trigger as trigger
import test_airbyte_admission as admission_tests
from airbyte_launch import ANNOTATION, Launch, WorkflowLaunch, WorkflowMetadata
from test_airbyte_admission import CONNECTION, UID, Fixture

fixture = admission_tests.fixture

PollRunner = Callable[[list[object]], tuple[int, int]]


@pytest.fixture
def run_poll(monkeypatch: pytest.MonkeyPatch) -> PollRunner:
    monkeypatch.setenv("JOB_ID", "123")
    monkeypatch.setenv("AIRBYTE_URL", "https://airbyte.example.com")
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "1801")
    monkeypatch.setenv("IDLE_THRESHOLD_SECONDS", "3600")
    monkeypatch.setenv("STATUS_UNREADABLE_THRESHOLD_SECONDS", "3600")
    monkeypatch.setattr(poll, "oauth_token", lambda: "test-token")

    def run(responses: list[object]) -> tuple[int, int]:
        elapsed = 0
        remaining = iter(responses)

        def sleep(seconds: int) -> None:
            nonlocal elapsed
            elapsed += seconds
            assert elapsed < 300000, "polling must terminate on the supplied terminal status"

        def urlopen(*args: object, **kwargs: object) -> io.StringIO:
            response = next(remaining)
            if isinstance(response, Exception):
                raise response
            return io.StringIO(json.dumps(response))

        monkeypatch.setattr(poll.time, "time", lambda: elapsed)
        monkeypatch.setattr(poll.time, "monotonic", lambda: elapsed)
        monkeypatch.setattr(poll.time, "sleep", sleep)
        monkeypatch.setattr(poll.urllib.request, "urlopen", urlopen)
        return poll.main(), elapsed

    return run


def job(status: str, records: int = 0) -> dict[str, object]:
    return {
        "job": {"status": status},
        "attempts": [
            {
                "attempt": {
                    "status": "running",
                    "totalStats": {"recordsEmitted": records},
                    "streamStats": [{"streamName": "issues"}],
                }
            }
        ],
    }


@pytest.mark.parametrize("status", ["pending", "queued", "running", "incomplete"])
def test_readable_nonterminal_jobs_can_wait_beyond_idle_threshold(run_poll: PollRunner, status: str) -> None:
    result, elapsed = run_poll([job(status)] * 4 + [job("succeeded")])
    assert result == 0, f"should keep waiting: {status}"
    assert elapsed > 3600


def test_rate_limit_wait_can_resume_and_complete(run_poll: PollRunner) -> None:
    result, _ = run_poll([job("running", 10)] * 4 + [job("running", 20), job("succeeded", 20)])
    assert result == 0


def test_readable_status_resets_outage_timer_without_record_progress(run_poll: PollRunner) -> None:
    result, _ = run_poll([job("running"), OSError("offline"), job("running"), OSError("offline"), job("succeeded")])
    assert result == 0


@pytest.mark.parametrize("unreadable", [OSError("offline"), {}, {"job": {"status": "unexpected"}}])
def test_continuous_unreadability_stops_monitoring(
    run_poll: PollRunner, unreadable: object, capsys: pytest.CaptureFixture[str]
) -> None:
    result, elapsed = run_poll([unreadable] * 4)
    assert result == 2
    assert 3600 <= elapsed <= 5403
    output = capsys.readouterr().err
    assert '"event": "sync.poll_failed"' in output
    assert '"event": "sync.completed"' not in output


@pytest.mark.parametrize(("status", "expected"), [("succeeded", 0), ("failed", 1), ("cancelled", 1)])
def test_terminal_status_wins_over_stale_counters(run_poll: PollRunner, status: str, expected: int) -> None:
    result, _ = run_poll([job("running"), job("running"), job(status)])
    assert result == expected, f"should honor terminal status: {status}"


def test_terminal_status_does_not_require_attempt_statistics(run_poll: PollRunner) -> None:
    result, _ = run_poll(
        [
            {
                "job": {"status": "succeeded"},
                "attempts": [{"attempt": {"totalStats": {"recordsEmitted": "bad"}, "streamStats": [{}]}}],
            }
        ]
    )
    assert result == 0


def test_readable_job_can_complete_after_48_hours(run_poll: PollRunner) -> None:
    result, elapsed = run_poll([job("running")] * 100 + [job("succeeded")])
    assert result == 0
    assert elapsed > 172800


def test_retry_with_unchanged_totals_can_complete(run_poll: PollRunner) -> None:
    retry = job("running")
    retry["attempts"] = [{"attempt": {"id": 1, "status": "running"}}]
    result, _ = run_poll([job("running"), job("incomplete"), retry, retry, job("succeeded")])
    assert result == 0


def test_permanent_auth_failure_does_not_claim_sync_completion(
    run_poll: PollRunner, capsys: pytest.CaptureFixture[str]
) -> None:
    result, _ = run_poll([poll.FatalError("credentials unavailable")])
    assert result == 1
    output = capsys.readouterr().err
    assert '"event": "sync.poll_failed"' in output
    assert '"event": "sync.completed"' not in output


def test_a_success_that_never_started_fails_the_step_and_logs_why(
    run_poll: PollRunner, capsys: pytest.CaptureFixture[str]
) -> None:
    not_started = {
        "job": {"status": "succeeded"},
        "attempts": [
            {
                "attempt": {
                    "status": "succeeded",
                    "failureSummary": {
                        "failures": [{"failureOrigin": "airbyte_platform", "internalMessage": "never started"}]
                    },
                }
            }
        ],
    }

    result, _ = run_poll([job("running"), not_started])

    assert result == 1
    output = capsys.readouterr().err
    assert '"event": "sync.not_run"' in output
    assert '"event": "sync.failure_reason"' in output
    assert '"failure_origin": "airbyte_platform"' in output
    assert '"status": "failed"' in output


def test_poller_recovers_its_existing_job_before_the_outage_deadline(run_poll, monkeypatch, tmp_path):
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "30")
    monkeypatch.setenv("STATUS_UNREADABLE_THRESHOLD_SECONDS", "1800")
    evidence = tmp_path / "evidence"
    monkeypatch.setenv("AIRBYTE_EVIDENCE_PATH", str(evidence))
    requests = []
    original = poll.airbyte_job

    def get(url, token, action, job_id):
        requests.append((action, job_id))
        assert not evidence.exists()
        return original(url, token, action, job_id)

    monkeypatch.setattr(poll, "airbyte_job", get)
    mismatched = {"job": {"id": 124, "status": "failed"}}
    succeeded = {"job": {"id": 123, "status": "succeeded"}, "attempts": [{"attempt": {"streamStats": [{}]}}]}
    result, elapsed = run_poll([OSError("offline")] * 10 + [mismatched, succeeded])
    assert result == 0
    assert elapsed == 11 * 30
    assert requests == [("get", 123)] * 12
    assert json.loads(evidence.read_text())["job_id"] == 123


def test_fatal_credentials_stop_even_with_a_zero_outage_threshold(
    run_poll: PollRunner, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("STATUS_UNREADABLE_THRESHOLD_SECONDS", "0")

    def fatal() -> str:
        raise poll.FatalError("credential access denied")

    def no_sleep(_seconds: int) -> None:
        pytest.fail("poller retried a permanent credential error")

    monkeypatch.setattr(poll, "oauth_token", fatal)
    monkeypatch.setattr(poll.time, "sleep", no_sleep)
    assert poll.main() == 1


def test_poll_retries_the_bronze_launch_when_argo_keeps_the_old_trigger(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    old = Launch(
        workflow_uid=UID,
        workflow_started_at=datetime(2025, 12, 31, tzinfo=UTC),
        connection=CONNECTION,
        previous_job=19,
        deadline=600,
        read_deadline=1800,
        outcome="accepted",
        job_id=20,
    )
    fixture.workflow[ANNOTATION] = old.model_dump_json()
    fixture.previous_jobs = (20, 19)
    fixture.job_id = 21
    fixture.nodes = iter(["4Gi", "6Gi"])
    for name, value in {
        "WORKFLOW_UID": str(UID),
        "JOB_ID": "20",
        "POLL_INTERVAL_SECONDS": "15",
        "STATUS_UNREADABLE_THRESHOLD_SECONDS": "3600",
        "TRIGGER_LAUNCH_EVIDENCE": old.model_dump_json(),
        "AIRBYTE_EVIDENCE_PATH": str(tmp_path / "poll"),
    }.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(poll, "oauth_token", lambda: "example-token")

    original = fixture.urlopen

    def urlopen(request: poll.urllib.request.Request, **kwargs: object) -> io.BytesIO:
        if request.full_url == "https://example.com/api/v1/jobs/get":
            assert json.loads(request.data or b"{}") == {"id": 21}
            result = job("succeeded")
            result["job"]["id"] = 21
            return io.BytesIO(json.dumps(result).encode())
        return original(request, **kwargs)

    monkeypatch.setattr(poll.urllib.request, "urlopen", urlopen)
    assert poll.main() == 0
    assert json.loads((tmp_path / "poll").read_text())["job_id"] == 21
    result = Launch.model_validate_json(fixture.workflow[ANNOTATION])
    assert (result.attempt, result.previous_job, result.job_id) == (2, 20, 21)
    assert result.pod_request is not None
    assert fixture.reads["v1/jobs/get"] == 2
    assert fixture.events.index("wait-start") < fixture.events.index("wait-end") < fixture.events.index("sync")
    assert fixture.events.count("sync") == 1


@pytest.mark.parametrize("failure", ["connection", "timeout", 429, 503, 401, 403, 404, "outage"])
def test_poll_start_retries_only_transient_workflow_reads_within_the_outage_bound(
    run_poll: PollRunner, monkeypatch: pytest.MonkeyPatch, failure: str | int
) -> None:
    receipt = Launch(
        workflow_uid=UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
        workflow_started_at=datetime(2026, 1, 1, tzinfo=UTC),
        connection=UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
        previous_job=122,
        deadline=600,
        read_deadline=1800,
        outcome="accepted",
        job_id=123,
    )
    for name, value in {
        "WORKFLOW_UID": str(receipt.workflow_uid),
        "CONNECTION_ID": str(receipt.connection),
        "LAUNCH_CONFIRMATION_SECONDS": "600",
        "LAUNCH_UNREADABLE_SECONDS": "1800",
        "STATUS_UNREADABLE_THRESHOLD_SECONDS": "5",
    }.items():
        monkeypatch.setenv(name, value)

    error = (
        urllib.error.HTTPError("https://kubernetes.example.com", failure, "fixture", {}, None)
        if isinstance(failure, int)
        else TimeoutError("fixture")
        if failure == "timeout"
        else urllib.error.URLError("fixture")
    )
    reads: list[float] = []
    store = WorkflowLaunch.__new__(WorkflowLaunch)

    def read(*, timeout: float = 30) -> WorkflowMetadata:
        reads.append(timeout)
        assert len(reads) <= 3, "Workflow read outlasted the outage bound"
        if len(reads) == 1 or failure == "outage":
            raise error
        return WorkflowMetadata(
            uid=receipt.workflow_uid,
            resourceVersion="1",
            annotations={ANNOTATION: receipt.model_dump_json()},
            started_at=receipt.workflow_started_at,
        )

    monkeypatch.setattr(store, "_request", read)
    monkeypatch.setattr(trigger, "WorkflowLaunch", lambda: store)
    result, elapsed = run_poll([job("succeeded")])
    if failure in (401, 403, 404):
        assert (result, elapsed) == (1, 0), "a permanent Workflow read error must fail immediately"
        assert len(reads) == 1
    elif failure == "outage":
        assert (result, elapsed) == (2, 5), "a Workflow read outage must stop at the unreadable bound"
        assert reads == [5, 4, 2]
    else:
        assert result == 0, "a transient Workflow read error must preserve a healthy sync"
        assert elapsed == 1
        assert reads == [5, 4]


@pytest.mark.parametrize(
    ("origin", "message", "reason"),
    [
        ("destination", "Code: 241. DB::Exception: User memory limit exceeded", "clickhouse_user_memory_limit"),
        ("destination", "Code: 241. DB::Exception: Query memory limit exceeded", "clickhouse_memory_limit"),
        ("destination", "Code: 241. DB::Exception: Total memory limit exceeded", "clickhouse_server_memory_pressure"),
        ("destination", "Destination reports OOMKilled", None),
        ("source", "Code: 241. DB::Exception: User memory limit exceeded", None),
    ],
)
def test_failed_load_evidence_distinguishes_clickhouse_memory_from_other_failures(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, origin: str, message: str, reason: str | None
) -> None:
    evidence = tmp_path / "evidence.json"
    monkeypatch.setenv("AIRBYTE_EVIDENCE_PATH", str(evidence))
    response = {
        "job": {"id": 123},
        "attempts": [
            {"attempt": {"failureSummary": {"failures": [{"failureOrigin": origin, "internalMessage": message}]}}}
        ],
    }
    poll.save_terminal_evidence(123, response, "failed")
    assert json.loads(evidence.read_text()).get("reason") == reason


def test_poll_uses_the_highest_attempt_and_the_user_limit_wins(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    evidence = tmp_path / "evidence.json"
    monkeypatch.setenv("AIRBYTE_EVIDENCE_PATH", str(evidence))
    latest_message = "Example wrapper. " * 40 + "Code: 241. User memory limit exceeded. Total memory limit exceeded"
    response = {
        "job": {"id": 123},
        "attempts": [
            {
                "attempt": {
                    "id": 3,
                    "totalStats": {"recordsEmitted": 5},
                    "failureSummary": {
                        "failures": [{"failureOrigin": "destination", "internalMessage": latest_message}]
                    },
                }
            },
            {
                "attempt": {
                    "id": 2,
                    "totalStats": {"recordsEmitted": 1},
                    "failureSummary": {
                        "failures": [
                            {
                                "failureOrigin": "destination",
                                "internalMessage": "Code: 241. Query memory limit exceeded",
                            }
                        ]
                    },
                }
            },
        ],
    }
    poll.save_terminal_evidence(123, response, "failed")
    report = json.loads(evidence.read_text())
    assert report["reason"] == "clickhouse_user_memory_limit"
    assert report["records_reported"] == 5


def test_capacity_poll_uses_the_status_deadline_for_its_initial_workflow_read(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    elapsed = 0.0
    monkeypatch.setenv("WORKFLOW_UID", str(UID))
    monkeypatch.setenv("JOB_ID", "20")
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "15")
    monkeypatch.setenv("STATUS_UNREADABLE_THRESHOLD_SECONDS", "5")
    monkeypatch.setattr(poll.time, "monotonic", lambda: elapsed)

    def sleep(seconds: float) -> None:
        nonlocal elapsed
        elapsed += seconds

    def urlopen(request: poll.urllib.request.Request, **kwargs: object) -> io.BytesIO:
        if request.full_url.endswith("/workflows/example"):
            raise urllib.error.URLError("example")
        return fixture.urlopen(request, **kwargs)

    monkeypatch.setattr(poll.time, "sleep", sleep)
    monkeypatch.setattr(poll.urllib.request, "urlopen", urlopen)
    assert poll.main() == 2
    assert elapsed == 5
    assert fixture.events == []


def test_switch_off_poll_exits_on_the_first_unparsable_workflow_read(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    elapsed = 0.0
    reads = []
    monkeypatch.setenv("AIRBYTE_CAPACITY_CHECK_ENABLED", "false")
    monkeypatch.setenv("WORKFLOW_UID", str(UID))
    monkeypatch.setenv("JOB_ID", "20")
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "15")
    monkeypatch.setenv("STATUS_UNREADABLE_THRESHOLD_SECONDS", "5")
    monkeypatch.setattr(poll.time, "monotonic", lambda: elapsed)

    def sleep(seconds: float) -> None:
        nonlocal elapsed
        elapsed += seconds

    def urlopen(request: poll.urllib.request.Request, **kwargs: object) -> io.BytesIO:
        if request.full_url.endswith("/workflows/example"):
            reads.append(request.get_method())
            return io.BytesIO(b'{"status":')
        return fixture.urlopen(request, **kwargs)

    monkeypatch.setattr(poll.time, "sleep", sleep)
    monkeypatch.setattr(poll.urllib.request, "urlopen", urlopen)

    assert poll.main() == 1
    assert reads == ["GET"] and elapsed == 0


def test_capacity_poll_uses_status_outage_handling_for_a_purged_old_job(
    fixture: Fixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    elapsed = 0.0
    old = Launch(
        workflow_uid=UID,
        workflow_started_at=datetime(2025, 12, 31, tzinfo=UTC),
        connection=CONNECTION,
        previous_job=19,
        deadline=600,
        read_deadline=1800,
        outcome="accepted",
        job_id=20,
    )
    fixture.workflow[ANNOTATION] = old.mark_json()
    monkeypatch.setenv("WORKFLOW_UID", str(UID))
    monkeypatch.setenv("JOB_ID", "20")
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "5")
    monkeypatch.setenv("STATUS_UNREADABLE_THRESHOLD_SECONDS", "10")
    monkeypatch.setattr(poll.time, "monotonic", lambda: elapsed)
    monkeypatch.setattr(poll, "oauth_token", lambda: "example-token")

    def sleep(seconds: float) -> None:
        nonlocal elapsed
        elapsed += seconds

    def request(url: str, token: str, body: bytes | None = None) -> bytes:
        if url.endswith("/jobs/get"):
            raise admission_tests.http_error(404)
        return fixture.airbyte(url, token, body)

    def urlopen(request: poll.urllib.request.Request, **kwargs: object) -> io.BytesIO:
        if request.full_url.endswith("/jobs/get"):
            assert json.loads(request.data or b"{}") == {"id": 20}
            raise admission_tests.http_error(404)
        return fixture.urlopen(request, **kwargs)

    monkeypatch.setattr(poll.time, "sleep", sleep)
    monkeypatch.setattr(trigger, "request", request)
    monkeypatch.setattr(poll.urllib.request, "urlopen", urlopen)
    assert poll.main() == 2
    assert elapsed == 10
    assert fixture.events == ["accepted"]
