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
from airbyte_launch import ANNOTATION, Launch, WorkflowLaunch, WorkflowMetadata

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
    run_poll: PollRunner, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("WORKFLOW_UID", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    monkeypatch.setenv("AIRBYTE_EVIDENCE_PATH", str(tmp_path / "poll"))
    receipt = Launch(
        workflow_uid=UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
        workflow_started_at=datetime(2026, 1, 1, tzinfo=UTC),
        connection=UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
        attempt=2,
        previous_job=123,
        deadline=600,
        read_deadline=1800,
        outcome="accepted",
        job_id=124,
    )

    old = receipt.model_copy(update={"attempt": 1, "job_id": 123})
    monkeypatch.setenv("TRIGGER_LAUNCH_EVIDENCE", old.model_dump_json())

    def launch(_url: str, prior: Launch | None, *, workflow_read_seconds: int = 0) -> Launch:
        assert prior == old
        assert workflow_read_seconds == 3600
        return receipt

    monkeypatch.setattr(poll, "workflow_launch", launch)
    succeeded = {"job": {"id": 124, "status": "succeeded"}, "attempts": [{"attempt": {"streamStats": [{}]}}]}
    result, _ = run_poll([succeeded])
    assert result == 0
    assert json.loads((tmp_path / "poll").read_text())["job_id"] == 124


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
