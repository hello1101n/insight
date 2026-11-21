"""The toolbox hands the poller exactly one durable Airbyte job."""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread
from uuid import UUID

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import airbyte_sync_trigger
import stage_admission
from airbyte_sync_poll import save_terminal_evidence


@pytest.fixture
def run(monkeypatch, tmp_path):
    for key, value in {
        "SYNC_ID": "uid",
        "WORKFLOW_NAME": "run-1",
        "ADMISSION_CONNECTOR": "jira",
        "ADMISSION_SOURCE_ID": "jira-one",
        "ADMISSION_STAGE": "bronze",
        "ADMISSION_ATTEMPT": "1",
        "CONNECTION_ID": "connection-one",
        "ADMISSION_MANAGED": "true",
    }.items():
        monkeypatch.setenv(key, value)
    token = tmp_path / "token"
    token.write_text("pod-token")
    monkeypatch.setattr(stage_admission, "TOKEN", token)
    monkeypatch.setattr(airbyte_sync_trigger, "oauth_token", lambda: "airbyte-token")
    calls = []
    replies = []

    class Server(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.command, self.path, self.headers["Authorization"], body))
            code, reply = replies.pop(0)
            self.send_response(code)
            self.end_headers()
            self.wfile.write(json.dumps(reply).encode())

        do_PUT = do_POST

        def log_message(self, *_):
            pass

    with HTTPServer(("127.0.0.1", 0), Server) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}"
        monkeypatch.setenv("STAGE_ADMISSION_URL", url)
        monkeypatch.setattr(airbyte_sync_trigger, "airbyte_api_url", lambda: url)
        yield replies, calls
        server.shutdown()
        thread.join()


@pytest.mark.parametrize("decision", ["granted", "queued"])
def test_register_returns_branch_and_working_pod_resources(run, decision, monkeypatch, tmp_path):
    replies, calls = run
    replies.append(
        (
            201,
            {
                "decision": decision,
                "resources": {
                    "cpu_millis": 500,
                    "memory_bytes": 1024,
                    "source_cpu_millis": 250,
                    "source_memory_bytes": 512,
                },
            },
        )
    )
    monkeypatch.setattr(stage_admission, "Path", lambda name: tmp_path / Path(name).name)
    assert stage_admission.register() == decision
    assert (tmp_path / "admission-memory_bytes").read_text() == "1024"
    assert (tmp_path / "admission-cpu_millis").read_text() == "500"
    assert calls == [("POST", stage_admission.BASE_PATH, "Bearer pod-token", stage_admission.stage_identity())]


@pytest.mark.parametrize("resources", [None, {"cpu_millis": True, "memory_bytes": 100}])
def test_unknown_resources_cannot_start_work(run, resources):
    run[0].append((200, {"decision": "granted", "resources": resources}))
    with pytest.raises(stage_admission.AdmissionError):
        stage_admission.register()


def test_trigger_retains_the_job_before_printing_it(run, capsys):
    replies, calls = run
    replies.extend(
        [(200, {"decision": "send"}), (200, {"job": {"id": 42}}), (200, {"decision": "poll", "job_id": "42"})]
    )
    assert airbyte_sync_trigger.main() == 0
    assert capsys.readouterr().out.strip() == "42"
    sender = str(UUID(calls[0][3]["sender"]))
    assert calls == [
        (
            "POST",
            stage_admission.BASE_PATH + "/airbyte-claim",
            "Bearer pod-token",
            {**stage_admission.stage_identity(), "sender": sender},
        ),
        ("POST", "/api/v1/connections/sync", "Bearer airbyte-token", {"connectionId": "connection-one"}),
        (
            "PUT",
            stage_admission.BASE_PATH + "/airbyte-job",
            "Bearer pod-token",
            {**stage_admission.stage_identity(), "job_id": 42},
        ),
    ]


def test_lost_start_reply_and_restarted_step_do_not_send_another_sync(run, capsys, monkeypatch):
    replies, calls = run
    replies.extend(
        [
            (200, {"decision": "send"}),
            (504, {}),
            (200, {"decision": "verify"}),
            (200, {"decision": "poll", "job_id": "73"}),
            (200, {"decision": "poll", "job_id": "73"}),
        ]
    )
    monkeypatch.setattr(stage_admission.time, "sleep", lambda _delay: None)
    assert airbyte_sync_trigger.main() == 0
    assert airbyte_sync_trigger.main() == 0
    assert capsys.readouterr().out.splitlines() == ["73", "73"]
    assert sum(c[1] == "/api/v1/connections/sync" for c in calls) == 1
    claims = [c[3].get("sender") for c in calls if c[1].endswith("/airbyte-claim")]
    assert len(claims) == 4
    assert claims[0] and claims[3] and claims[0] != claims[3]
    assert claims[1:3] == [None, None]


def test_refused_claim_fails_before_airbyte(run):
    replies, calls = run
    replies.append((409, {}))
    with pytest.raises(stage_admission.AdmissionError):
        airbyte_sync_trigger.main()
    assert len(calls) == 1


def test_terminal_observation_only_contains_metrics_from_its_own_job(monkeypatch, tmp_path):
    path = tmp_path / "evidence"
    monkeypatch.setenv("AIRBYTE_EVIDENCE_PATH", str(path))
    resp = {"job": {"id": 41}, "attempts": [{"attempt": {"totalStats": {"recordsEmitted": 0, "bytesEmitted": 123}}}]}
    save_terminal_evidence(42, resp, "succeeded")
    assert not path.exists()
    save_terminal_evidence(41, resp, "succeeded")
    assert json.loads(path.read_text()) == {
        "job_id": 41,
        "status": "succeeded",
        "attempts": [{"status": None, "records_emitted": 0}],
        "records_reported": 0,
        "volume_bytes": 123,
    }
    save_terminal_evidence(41, {"job": {"id": 41}}, "failed")
    assert json.loads(path.read_text()) == {"job_id": 41, "status": "failed"}


def test_source_sizing_changes_only_sync_and_preserves_a_larger_cpu_limit(monkeypatch):
    import airbyte_admission

    monkeypatch.setenv("CONNECTION_ID", "conn")
    monkeypatch.setenv("AIRBYTE_SOURCE_CPU_MILLIS", "1000")
    monkeypatch.setenv("AIRBYTE_SOURCE_MEMORY_BYTES", str(3 * 1024**3))
    monkeypatch.setenv("ADMISSION_ATTEMPT", "2")
    calls = []
    allocation = {
        "default": {"cpu_limit": "2"},
        "jobSpecific": [
            {"jobType": "sync", "resourceRequirements": {"memory_limit": "2Gi"}},
            {"jobType": "check_connection", "resourceRequirements": {"memory_limit": "256Mi"}},
        ],
    }

    def reply(path, body):
        calls.append(path)
        if path == "connections/get":
            return {"connectionId": "conn", "sourceId": "source", "destinationId": "shared"}
        if path == "sources/get":
            return {
                "sourceId": "source",
                "sourceDefinitionId": "def",
                "resourceAllocation": allocation,
                "numConnections": 1,
            }
        if path == "source_definitions/get":
            return {"sourceDefinitionId": "def", "resourceRequirements": {"default": {"memory_request": "2Gi"}}}
        assert path == "sources/partial_update"
        return body

    monkeypatch.setattr(airbyte_admission, "airbyte", reply)
    airbyte_admission.prepare_source()
    assert calls == ["connections/get", "sources/get", "source_definitions/get", "sources/partial_update"]
    assert allocation["jobSpecific"][0]["resourceRequirements"] == {
        "cpu_request": "1000m",
        "cpu_limit": "2",
        "memory_request": str(3 * 1024**3),
        "memory_limit": str(3 * 1024**3),
    }
    assert allocation["jobSpecific"][1]["resourceRequirements"] == {"memory_limit": "256Mi"}
    assert allocation["default"] == {"cpu_limit": "2"}


@pytest.mark.parametrize(
    ("modes", "safe"),
    [
        ([("incremental", "append"), ("incremental", "append_dedup")], True),
        ([("incremental", "append"), ("full_refresh", "overwrite")], False),
        ([], False),
    ],
)
def test_replay_checks_every_stream(modes, safe):
    from airbyte_admission import replay_mode_safe

    streams = [{"config": {"syncMode": sync, "destinationSyncMode": destination}} for sync, destination in modes]
    assert replay_mode_safe({"syncCatalog": {"streams": streams}}) == safe


def test_retry_needs_both_nondestructive_streams_and_connectors_proof(run, monkeypatch):
    import airbyte_admission

    replies, calls = run
    live = {"syncCatalog": {"streams": [{"config": {"syncMode": "incremental", "destinationSyncMode": "append"}}]}}
    monkeypatch.setattr(airbyte_admission, "connection", lambda: live)
    monkeypatch.setattr(airbyte_admission.time, "sleep", lambda _delay: None)
    replies.extend([(200, {"decision": "verify"}), (200, {"decision": "retry"}), (200, {"decision": "retry"})])
    assert airbyte_admission.retry_allowed()
    live["syncCatalog"]["streams"][0]["config"]["destinationSyncMode"] = "overwrite"
    assert not airbyte_admission.retry_allowed()
    assert [c[3]["replay_mode_safe"] for c in calls] == [True, True, False]


def test_registration_survives_the_connectors_service_restarting(run, monkeypatch):
    replies, calls = run
    replies.extend([(503, {}), (200, {"decision": "queued"})])
    delays = []
    monkeypatch.setattr(stage_admission.time, "sleep", delays.append)
    assert stage_admission.request("POST")["decision"] == "queued"
    assert len(calls) == 2 and calls[0] == calls[1]
    assert delays == [1]


@pytest.mark.parametrize("first_id,first_status", [(31, "pending"), (131, "pending"), (31, "running")])
def test_placement_observations_never_cancel_a_native_job(run, monkeypatch, first_id, first_status):
    import airbyte_sync_poll

    replies, calls = run
    replies.extend([(200, {"cancel": True})] * 3)
    responses = [
        {"job": {"id": first_id, "status": first_status}},
        {"job": {"id": 31, "status": "succeeded"}, "attempts": [{"attempt": {"streamStats": [{}]}}]},
    ]
    actions = []

    def job(_url, _token, action, job_id):
        actions.append((action, job_id))
        return responses.pop(0)

    monkeypatch.setenv("JOB_ID", "31")
    monkeypatch.setenv("POLL_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("STATUS_UNREADABLE_THRESHOLD_SECONDS", "0")
    monkeypatch.setattr(airbyte_sync_poll, "airbyte_api_url", lambda: "local")
    monkeypatch.setattr(airbyte_sync_poll, "oauth_token", lambda: "token")
    monkeypatch.setattr(airbyte_sync_poll.time, "sleep", lambda _n: None)
    monkeypatch.setattr(airbyte_sync_poll, "airbyte_job", job)
    assert airbyte_sync_poll.main() == 0
    assert actions == [("get", 31), ("get", 31)]
    assert calls == []


def test_only_the_selected_streams_and_their_modes_define_comparable_history():
    from airbyte_catalog_signature import signature

    def entry(name, selected=True):
        return {
            "stream": {"name": name},
            "config": {"selected": selected, "syncMode": "incremental", "destinationSyncMode": "append"},
        }

    streams = [entry("a"), entry("b"), entry("unused", False)]
    conn = {"syncCatalog": {"streams": streams}}
    first = signature(conn)
    assert len(first) == 64
    streams.reverse()
    assert signature(conn) == first
    streams[1]["config"]["syncMode"] = "full_refresh"
    assert signature(conn) != first
    del streams[1]["config"]["destinationSyncMode"]
    assert signature(conn) == ""


def test_lost_claim_response_reuses_sender_before_one_native_post(run, monkeypatch):
    replies, calls = run
    monkeypatch.setattr(stage_admission.time, "sleep", lambda _: None)
    replies.extend(
        [
            (503, {}),
            (200, {"decision": "send"}),
            (200, {"job": {"id": 42}}),
            (200, {"decision": "poll", "job_id": "42"}),
        ]
    )
    assert airbyte_sync_trigger.main() == 0
    assert calls[0] == calls[1]
    assert UUID(calls[0][3]["sender"]).version == 4
    assert sum(c[1] == "/api/v1/connections/sync" for c in calls) == 1
