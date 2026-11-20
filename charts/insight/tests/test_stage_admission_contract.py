from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

CHART = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def charts():
    subprocess.run(["helm", "dependency", "build", str(CHART), "--skip-refresh"], check=True, capture_output=True)
    renders = {}
    for enabled in (False, True):
        rendered = subprocess.check_output(
            [
                "helm",
                "template",
                "contract",
                str(CHART),
                "-f",
                str(CHART / "tests/values.yaml"),
                "--set",
                "connectors.stageAdmission.enabled=" + str(enabled).lower(),
            ],
            text=True,
        )
        renders[enabled] = {
            d["metadata"]["name"]: {t["name"]: t for t in d["spec"]["templates"]}
            for d in yaml.safe_load_all(rendered)
            if d and d["kind"] == "WorkflowTemplate"
        }
    return renders


def test_both_transform_paths_take_their_own_gate(charts):
    stage_names = {
        "transform-jira-staging",
        "transform-staging",
        "identity-seed",
        "transform-jira-silver",
        "transform-legacy",
        "connector-checks",
    }
    tasks = {t["name"]: t for t in charts[True]["ingestion-pipeline"]["transform"]["dag"]["tasks"]}
    for name in stage_names:
        gate_name = "admit-" + name
        assert tasks[gate_name]["templateRef"] == {"name": "stage-admission", "template": "gate"}
        assert gate_name in tasks[name]["depends"]
        assert next(v["value"] for v in tasks[gate_name]["arguments"]["parameters"] if v["name"] == "stage") == name
        work_input = {v["name"]: v["value"] for v in tasks[name]["arguments"]["parameters"]}
        assert gate_name in work_input["cpu_millis"] and gate_name in work_input["memory_bytes"]
    assert tasks["admit-identity-seed"]["depends"] == "transform-jira-staging.Succeeded || transform-staging.Succeeded"
    legacy = charts[False]["ingestion-pipeline"]["transform"]["dag"]["tasks"]
    assert stage_names == {t["name"] for t in legacy}
    assert "stage-admission" not in charts[False]


def test_queued_suspends_exact_stage_attempt_and_granted_goes_straight_to_work(charts):
    gates = charts[True]["stage-admission"]
    request, wait = [group[0] for group in gates["gate"]["steps"]]
    assert request["template"] == "request-stage"
    assert wait["when"] == "{{steps.request.outputs.result}} == queued"
    assert wait["template"] == "wait-stage"
    assert gates["wait-stage"]["suspend"] == {}
    assert {p["name"] for p in gates["wait-stage"]["inputs"]["parameters"]} == {"stage", "attempt", "admission_sync_id"}
    token = gates["request-stage"]["volumes"][0]["projected"]["sources"][0]["serviceAccountToken"]
    assert token["audience"] == "insight-connectors"
    for name in ("dbt-run", "identity-seed-run", "connector-checks"):
        run = charts[True][name]["run"]
        assert "insight:sync=" in str(run) or "ADMISSION_STAGE" in str(run)
        assert "cpu_millis" in run["podSpecPatch"]
        assert "stage-auth" not in str(run)


def test_bronze_resolves_once_then_sizes_the_source_before_either_send(charts):
    airbyte = charts[True]["airbyte-sync"]
    resolve, first, check, second, legacy = [group[0] for group in airbyte["main"]["steps"]]
    assert resolve["template"] == "resolve-connection-by-name"
    assert first["template"] == second["template"] == "managed-attempt"
    assert check["template"] == "retry-bronze" and "Failed|Error" in check["when"]
    assert "check-retry.status" in second["when"]
    assert "!= 'true'" in legacy["when"]
    assert [
        next(p["value"] for p in t["arguments"]["parameters"] if p["name"] == "attempt") for t in (first, second)
    ] == ["1", "2"]
    admit, prepare, start = [g[0] for g in airbyte["managed-attempt"]["steps"]]
    assert admit["templateRef"]["template"] == "gate"
    assert prepare["template"] == "prepare-source" and start["template"] == "sync"
    assert [group[0]["template"] for group in airbyte["sync"]["steps"]] == ["trigger-sync", "poll-job"]
    assert "airbyte-evidence" in str(airbyte["poll-job"]["outputs"])
    assert "AIRBYTE_EVIDENCE_PATH" in str(airbyte["poll-job"]["container"]["env"])
    assert "airbyte-send-evidence" in str(airbyte["trigger-sync"]["outputs"])
    assert "stage-auth" not in str(airbyte["prepare-source"])


def test_deleted_managed_poller_can_be_replaced_after_a_long_running_job(charts):
    retry = charts[True]["airbyte-sync"]["poll-job"]["retryStrategy"]
    assert retry["retryPolicy"] == "OnError" and retry["limit"] > 0
    assert retry["backoff"]["maxDuration"] == "{{=inputs.parameters.admission_managed == 'true' ? '' : '5m'}}"
    assert retry["backoff"]["cap"] == "5m"
    assert charts[False]["airbyte-sync"]["poll-job"]["retryStrategy"]["backoff"]["maxDuration"] == "5m"
