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
                "ingestion.maxConcurrentBronzeLoads=3,ingestion.maxConcurrentConnectorChecks=4,ingestion.maxConcurrentSyncs=6,ingestion.airbyteSync.launchConfirmationSeconds=901,ingestion.airbyteSync.launchUnreadableSeconds=2000",
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
    assert all("synchronization" not in spec for spec in pipeline.values())
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


def test_only_bronze_and_checks_hold_their_slots(charts: dict[str, dict]) -> None:
    for release, counts in [
        ("defaults", {"bronze": "2", "checks": "2", "syncs": "4"}),
        ("overrides", {"bronze": "3", "checks": "4", "syncs": "6"}),
    ]:
        chart = charts[release]
        bronze = templates(chart, "airbyte-sync")
        pipeline = templates(chart, "ingestion-pipeline")["pipeline"]
        sync = next(task for task in pipeline["dag"]["tasks"] if task["name"] == "sync")
        assert sync["templateRef"] == {"name": "airbyte-sync", "template": "main"}
        assert chart["ConfigMap", "insight-sync-limits"]["data"] == counts
        for spec, key in [(bronze["main"], "bronze"), (templates(chart, "connector-checks")["run"], "checks")]:
            assert spec["synchronization"] == {
                "semaphores": [{"configMapKeyRef": {"name": "insight-sync-limits", "key": key}}]
            }
        assert all("synchronization" not in spec for name, spec in bronze.items() if name != "main")


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


def test_sync_credentials_are_scoped_to_syncs(charts: dict[str, dict]) -> None:
    default = charts["defaults"]
    reconcile = default["CronWorkflow", "contract-reconcile-loop"]
    env = reconcile["spec"]["workflowSpec"]["templates"][0]["container"]["env"]
    assert {
        "name": "RECONCILE_DEST_CLICKHOUSE_PASSWORD",
        "valueFrom": {"secretKeyRef": {"name": "insight-db-creds", "key": "clickhouse-password"}},
    } in env
    assert ("ConfigMap", "contract-reconcile-destinations") not in default
    for name in ("dbt-run", "connector-checks"):
        run = templates(default, name)["run"]
        assert {"name": "clickhouse_user", "default": "test"} in run["inputs"]["parameters"]
        assert {
            "name": "CLICKHOUSE_PASSWORD",
            "valueFrom": {"secretKeyRef": {"name": "insight-db-creds", "key": "clickhouse-password"}},
        } in run["script"]["env"]

    for provision in (True, False):
        args = [
            "--set",
            "clickhouse.syncUser.username=etl,clickhouse.syncUser.passwordSecret.name=etl-credentials,clickhouse.syncUser.passwordSecret.key=etl-password,clickhouse.syncUser.totalMemoryBytes=12884901888",
            "--set",
            f"clickhouse.provisionAccess={str(provision).lower()}",
        ]
        chart = render(*args)
        credentials = {"valueFrom": {"secretKeyRef": {"name": "etl-credentials", "key": "etl-password"}}}
        for name in ("dbt-run", "connector-checks"):
            env = templates(chart, name)["run"]["script"]["env"]
            assert {"name": "CLICKHOUSE_USER", "value": "etl"} in env
            assert {"name": "CLICKHOUSE_PASSWORD", **credentials} in env
        identity = "APP__gears__identity_resolution__config__clickhouse_"
        seed = templates(chart, "identity-seed-run")["run"]["container"]["env"]
        assert {"name": identity + "user", "value": "etl"} in seed
        assert {"name": identity + "password", **credentials} in seed
        reconcile = next(item for (kind, name), item in chart.items() if kind == "CronWorkflow" and "reconcile" in name)
        env = reconcile["spec"]["workflowSpec"]["templates"][0]["container"]["env"]
        assert {"name": "RECONCILE_DEST_CLICKHOUSE_USERNAME", "value": "etl"} in env
        assert {"name": "RECONCILE_SYNC_PASSWORD_SECRET", "value": "etl-credentials"} in env
        assert {"name": "RECONCILE_SYNC_PASSWORD_KEY", "value": "etl-password"} in env
        assert all(entry["name"] != "RECONCILE_DEST_CLICKHOUSE_PASSWORD" for entry in env)
        assert {"name": "RECONCILE_DESTINATION_STATE", "value": "contract-reconcile-destinations"} in env
        assert ("ConfigMap", "contract-reconcile-destinations") in chart
        assert {
            "apiGroups": [""],
            "resources": ["configmaps"],
            "resourceNames": ["contract-reconcile-destinations"],
            "verbs": ["patch"],
        } in chart["Role", "contract-reconcile"]["rules"]
        ddl = next(
            item for (kind, name), item in chart.items() if kind == "Job" and name.endswith("clickhouse-databases")
        )
        env = ddl["spec"]["template"]["spec"]["containers"][0]["env"]
        assert ({"name": "CLICKHOUSE_SYNC_PASSWORD", **credentials} in env) == provision
        for service, key in [("analytics", "analytics"), ("identity-resolution", "identity_resolution")]:
            field = f"APP__gears__{key}__config__clickhouse_user"
            assert chart["Secret", f"insight-{service}-config"]["stringData"][field] == "test"

    inline = render(
        "--set",
        "clickhouse.syncUser.username=etl,clickhouse.syncUser.password=example-password,clickhouse.syncUser.totalMemoryBytes=12884901888",
    )
    secret = inline["Secret", "contract-clickhouse-sync"]
    assert secret["stringData"] == {"password": "example-password"}
    assert secret["metadata"]["annotations"]["helm.sh/hook-weight"] == "-5"
    assert {
        "name": "CLICKHOUSE_PASSWORD",
        "valueFrom": {"secretKeyRef": {"name": "contract-clickhouse-sync", "key": "password"}},
    } in templates(inline, "dbt-run")["run"]["script"]["env"]
    reconcile = inline["CronWorkflow", "contract-reconcile-loop"]
    env = reconcile["spec"]["workflowSpec"]["templates"][0]["container"]["env"]
    assert {"name": "RECONCILE_SYNC_PASSWORD_SECRET", "value": "contract-clickhouse-sync"} in env
    assert {"name": "RECONCILE_SYNC_PASSWORD_KEY", "value": "password"} in env


def test_sync_budget_must_fit_below_the_known_clickhouse_limit() -> None:
    with pytest.raises(subprocess.CalledProcessError) as error:
        render(
            "--set",
            "clickhouse.syncUser.username=etl,clickhouse.syncUser.password=pw,clickhouse.syncUser.totalMemoryBytes=12884901888,clickhouse.serverMemoryLimitBytes=12884901888",
        )
    assert "must be below clickhouse.serverMemoryLimitBytes" in error.value.stderr
    render(
        "--set",
        "clickhouse.syncUser.username=etl,clickhouse.syncUser.password=pw,clickhouse.syncUser.totalMemoryBytes=12884901888,clickhouse.serverMemoryLimitBytes=12884901889",
    )


def test_memory_byte_values_from_a_values_file_render_as_integers(tmp_path: Path) -> None:
    values = tmp_path / "sync.yaml"
    values.write_text(
        "clickhouse:\n  syncUser:\n    username: etl\n    password: example\n"
        "    totalMemoryBytes: 12884901888\n    queryMemoryBytes: 1073741824\n"
    )
    chart = render("-f", str(values))
    jobs = [doc for (kind, name), doc in chart.items() if kind == "Job" and "clickhouse" in name]
    settings = [
        {entry["name"]: entry.get("value") for entry in job["spec"]["template"]["spec"]["containers"][0]["env"]}
        for job in jobs
        if job["metadata"]["name"].endswith(("clickhouse-databases", "clickhouse-migrate"))
    ]
    assert len(settings) == 2
    for env in settings:
        assert env["CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES"] == "12884901888"
        assert env["CLICKHOUSE_SYNC_QUERY_MEMORY_BYTES"] == "1073741824"


def test_sync_user_requires_a_budget_or_derives_it_from_the_server_limit() -> None:
    user = "clickhouse.syncUser.username=etl,clickhouse.syncUser.password=example"
    with pytest.raises(subprocess.CalledProcessError) as error:
        render("--set", user)
    assert "Set clickhouse.syncUser.totalMemoryBytes or clickhouse.serverMemoryLimitBytes" in error.value.stderr

    chart = render("--set", f"{user},clickhouse.serverMemoryLimitBytes=10000000001")
    ddl = chart["Job", "contract-clickhouse-databases"]["spec"]["template"]["spec"]["containers"][0]
    env = {item["name"]: item.get("value") for item in ddl["env"]}
    assert env["CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES"] == "6000000000"
    assert "CLICKHOUSE_SYNC_QUERY_MEMORY_BYTES" not in env


def render(*args: str) -> dict[tuple[str, str], dict]:
    result = subprocess.run(
        ["helm", "template", "contract", str(CHART), "-f", str(CHART / "tests/values.yaml"), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return {(doc["kind"], doc["metadata"]["name"]): doc for doc in yaml.safe_load_all(result.stdout) if doc}
