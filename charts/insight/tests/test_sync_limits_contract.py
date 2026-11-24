from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
import yaml

CHART = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def charts() -> dict[str, dict[tuple[str, str], dict]]:
    subprocess.run(["helm", "dependency", "build", str(CHART), "--skip-refresh"], check=True, capture_output=True)
    renders = {}
    for release, options in [
        ("defaults", []),
        (
            "overrides",
            [
                "--set",
                "ingestion.maxConcurrentSyncs=2,ingestion.airbyteSync.launchConfirmationSeconds=901,ingestion.airbyteSync.launchUnreadableSeconds=2000",
            ],
        ),
    ]:
        rendered = subprocess.check_output(
            ["helm", "template", "contract", str(CHART), "-f", str(CHART / "tests/values.yaml"), *options], text=True
        )
        renders[release] = {
            (item["kind"], item["metadata"]["name"]): item for item in yaml.safe_load_all(rendered) if item
        }
    return renders


def templates(chart: dict[tuple[str, str], dict], workflow: str) -> dict[str, dict]:
    return {item["name"]: item for item in chart["WorkflowTemplate", workflow]["spec"]["templates"]}


def test_pipeline_serializes_each_writer_group_without_a_gate(charts: dict[str, dict]) -> None:
    default = charts["defaults"]
    pipeline = templates(default, "ingestion-pipeline")
    assert pipeline["pipeline"]["synchronization"] == {
        "semaphores": [{"configMapKeyRef": {"name": "insight-sync-limits", "key": "syncs"}}]
    }
    assert default["ConfigMap", "insight-sync-limits"]["data"]["syncs"] == "4"
    assert charts["overrides"]["ConfigMap", "insight-sync-limits"]["data"]["syncs"] == "2"
    assert ("WorkflowTemplate", "stage-admission") not in default
    groups = {
        "transform-jira-staging": "staging",
        "transform-staging": "staging",
        "transform-jira-silver": "downstream",
        "transform-legacy": "downstream",
        "identity-seed": None,
        "connector-checks": None,
    }
    tasks = {task["name"]: task for task in pipeline["transform"]["dag"]["tasks"]}
    assert tasks.keys() == groups.keys()
    for name, group in groups.items():
        params = {p["name"]: p["value"] for p in tasks[name].get("arguments", {}).get("parameters", [])}
        assert params.get("lock_group") == group, name
        if group is not None:
            assert params["stage_name"] == name
    assert templates(default, "dbt-run")["run"]["synchronization"]["mutexes"] == [
        {"name": "ch-{{inputs.parameters.lock_group}}"}
    ]
    assert templates(default, "identity-seed-run")["run"]["synchronization"]["mutexes"] == [{"name": "ch-identity"}]
    assert "synchronization" not in templates(default, "connector-checks")["run"]


def test_bronze_uses_three_pods_and_passes_the_confirmation_window(charts: dict[str, dict]) -> None:
    for release, window, unreadable in [("defaults", "600", "1800"), ("overrides", "901", "2000")]:
        airbyte = templates(charts[release], "airbyte-sync")
        assert [group[0]["template"] for group in airbyte["main"]["steps"]] == ["resolve-connection-by-name", "sync"]
        assert [group[0]["template"] for group in airbyte["sync"]["steps"]] == ["trigger-sync", "poll-job"]
        assert {name for name, spec in airbyte.items() if "script" in spec or "container" in spec} == {
            "resolve-connection-by-name",
            "trigger-sync",
            "poll-job",
        }
        trigger = airbyte["trigger-sync"]
        env = {item["name"]: item["value"] for item in trigger["container"]["env"] if "value" in item}
        assert env["LAUNCH_CONFIRMATION_SECONDS"] == window
        assert env["LAUNCH_UNREADABLE_SECONDS"] == unreadable
        poll_env = {item["name"]: item.get("value") for item in airbyte["poll-job"]["container"]["env"]}
        assert poll_env["LAUNCH_UNREADABLE_SECONDS"] == unreadable
        assert poll_env["WORKFLOW_UID"] == env["WORKFLOW_UID"]
        assert airbyte["poll-job"]["serviceAccountName"] == trigger["serviceAccountName"]
        assert env["WORKFLOW_UID"] == "{{workflow.uid}}"
        assert trigger["retryStrategy"]["retryPolicy"] == "Always"
        assert "serviceAccountName" in trigger
        assert "airbyte-evidence" in str(airbyte["poll-job"]["outputs"])


def test_airbyte_launch_role_grants_only_claim_and_executor_access(charts: dict[str, dict]) -> None:
    chart = charts["defaults"]
    name = templates(chart, "airbyte-sync")["trigger-sync"]["serviceAccountName"]
    assert chart["Role", name]["rules"] == [
        {"apiGroups": ["argoproj.io"], "resources": ["workflows"], "verbs": ["get", "patch"]},
        {"apiGroups": ["argoproj.io"], "resources": ["workflowtaskresults"], "verbs": ["create", "patch"]},
    ]
    binding = chart["RoleBinding", name]
    assert binding["roleRef"] == {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": name}
    assert binding["subjects"] == [{"kind": "ServiceAccount", "name": name, "namespace": "default"}]


def test_identity_tags_clickhouse_queries_and_reports_the_pod_uid(charts: dict[str, dict]) -> None:
    seed = templates(charts["defaults"], "identity-seed-run")["run"]
    container = seed["container"]
    env = {entry["name"]: entry for entry in container["env"]}
    assert env["WORKFLOW_UID"]["value"] == "{{workflow.uid}}"
    assert env["POD_UID"]["valueFrom"]["fieldRef"]["fieldPath"] == "metadata.uid"
    assert env["INSIGHT_QUERY_TAG"]["value"] == "insight:sync=$(WORKFLOW_UID):stage=identity-seed:pod=$(POD_UID)"
    assert seed["outputs"]["parameters"] == [{"name": "query-pod-uid", "valueFrom": {"path": "/app/data/pod-uid"}}]
    assert """printf '%s' "$POD_UID" > /app/data/pod-uid""" in container["args"][0]
    assert container["args"][2:] == ["-c", "/app/config/insight.yaml", "seed", "--guard-ok"]
