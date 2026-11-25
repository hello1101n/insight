from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
import yaml

CHART = Path(__file__).resolve().parents[1]


@pytest.fixture(scope="module")
def resource_parameter_names() -> dict[str, str]:
    fixture = CHART.parents[1] / "tests/fixtures/connector-resource-parameters.json"
    return json.loads(fixture.read_text())["parameters"]


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
                "ingestion.airbyteSync.launchConfirmationSeconds=901,ingestion.airbyteSync.launchUnreadableSeconds=2000",
                "--set",
                "ingestion.syncResourceDefaults.airbyte_cpu_millis=1000,ingestion.syncResourceDefaults.airbyte_memory_bytes=1073741824,ingestion.syncResourceDefaults.dbt_cpu_millis=2000,ingestion.syncResourceDefaults.dbt_memory_bytes=2147483648,ingestion.syncResourceDefaults.identity_cpu_millis=250,ingestion.syncResourceDefaults.identity_memory_bytes=536870912,ingestion.syncResourceDefaults.dbt_query_memory_bytes=5368709120",
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


def test_bronze_and_checks_run_without_argo_synchronization(charts: dict[str, dict]) -> None:
    for chart in charts.values():
        bronze = templates(chart, "airbyte-sync")
        pipeline = templates(chart, "ingestion-pipeline")["pipeline"]
        sync = next(task for task in pipeline["dag"]["tasks"] if task["name"] == "sync")
        assert sync["templateRef"] == {"name": "airbyte-sync", "template": "main"}
        assert "synchronization" not in templates(chart, "connector-checks")["run"]
        assert ("ConfigMap", "insight-sync" + "-limits") not in chart
        assert all("synchronization" not in spec for spec in bronze.values())


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
    account = templates(chart, "airbyte-sync")["poll-job"]["serviceAccountName"]
    name = chart["RoleBinding", f"{account}-workflow"]["roleRef"]["name"]
    assert chart["Role", name]["rules"] == [
        {"apiGroups": ["argoproj.io"], "resources": ["workflows"], "verbs": ["get", "patch"]},
        {"apiGroups": ["argoproj.io"], "resources": ["workflowtaskresults"], "verbs": ["create", "patch"]},
    ]
    binding = chart["RoleBinding", name]
    assert binding["roleRef"] == {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": name}
    assert binding["subjects"] == [{"kind": "ServiceAccount", "name": name, "namespace": "default"}]


def test_capacity_access_and_settings_are_scoped_to_the_enabled_launch_steps(charts: dict[str, dict]) -> None:
    chart = charts["defaults"]
    airbyte = templates(chart, "airbyte-sync")
    trigger = airbyte["trigger-sync"]
    account = trigger["serviceAccountName"]
    cluster_role = f"{account}.default"
    subject = [{"kind": "ServiceAccount", "name": account, "namespace": "default"}]
    assert chart["ClusterRole", cluster_role]["rules"] == [
        {"apiGroups": [""], "resources": ["nodes"], "verbs": ["get", "list"]},
        {"apiGroups": [""], "resources": ["pods"], "verbs": ["list"]},
    ]
    assert chart["ClusterRoleBinding", cluster_role]["subjects"] == subject
    assert chart["ClusterRoleBinding", cluster_role]["roleRef"]["name"] == cluster_role
    assert chart["Role", account]["rules"] == [
        {
            "apiGroups": ["coordination.k8s.io"],
            "resources": ["leases"],
            "resourceNames": [account],
            "verbs": ["get", "patch"],
        }
    ]
    assert chart["RoleBinding", account]["subjects"] == subject
    assert chart["RoleBinding", account]["roleRef"]["name"] == account
    assert chart["RoleBinding", f"{account}-workflow"]["subjects"] == subject
    assert chart["RoleBinding", f"{account}-workflow"]["roleRef"]["name"] == "contract-airbyte-trigger"
    assert airbyte["poll-job"]["serviceAccountName"] == account
    assert airbyte["resolve-connection-by-name"].get("serviceAccountName") != account
    assert subject[0] in chart["RoleBinding", "contract-airbyte-auth-reader"]["subjects"]
    assert ("ServiceAccount", account) in chart
    assert ("Lease", account) in chart
    env = {item["name"]: item for item in trigger["container"]["env"]}
    assert env["AIRBYTE_CAPACITY_CHECK_ENABLED"]["value"] == "true"
    for name in ("AIRBYTE_CAPACITY_SETTINGS", "AIRBYTE_CAPACITY_LEASE", "POD_UID"):
        poll_env = {item["name"]: item for item in airbyte["poll-job"]["container"]["env"]}
        assert poll_env[name] == env[name]
    assert env["AIRBYTE_CAPACITY_LEASE"]["value"] == account
    assert env["POD_UID"]["valueFrom"]["fieldRef"]["fieldPath"] == "metadata.uid"
    assert json.loads(env["AIRBYTE_CAPACITY_SETTINGS"]["value"]) == {
        "nodeSelector": {},
        "requests": {
            "orchestrator": {"cpu": "1", "memory": "2Gi"},
            "source": {"cpu": "1", "memory": "2Gi"},
            "destination": {"cpu": "500m", "memory": "1Gi"},
            "init": {"cpu": "1", "memory": "2Gi"},
        },
    }

    disabled = render("--set", "ingestion.airbyteSync.capacityCheck.enabled=false")
    assert all("airbyte-capacity" not in name for _, name in disabled)
    assert subject[0] not in disabled["RoleBinding", "contract-airbyte-auth-reader"]["subjects"]
    airbyte = templates(disabled, "airbyte-sync")
    assert airbyte["trigger-sync"]["serviceAccountName"] == airbyte["poll-job"]["serviceAccountName"]
    for step in ("trigger-sync", "poll-job"):
        assert all(not item["name"].startswith("AIRBYTE_CAPACITY_") for item in airbyte[step]["container"]["env"])
    assert all(item["name"] != "SYNC_RESOURCES" for item in airbyte["poll-job"]["container"]["env"])

    override = render(
        "--set-string",
        "ingestion.airbyteSync.capacityCheck.nodeSelector.pool=jobs",
        "--set-string",
        "ingestion.airbyteSync.capacityCheck.requests.source.cpu=1500m",
    )
    separate_release = render("--set-string", "fullnameOverride=another")
    assert ("Lease", "another-airbyte-capacity") in separate_release and ("Lease", account) not in separate_release

    trigger_env = templates(override, "airbyte-sync")["trigger-sync"]["container"]["env"]
    settings = json.loads(next(item["value"] for item in trigger_env if item["name"] == "AIRBYTE_CAPACITY_SETTINGS"))
    assert settings["nodeSelector"] == {"pool": "jobs"}
    assert settings["requests"]["source"] == {"cpu": "1500m", "memory": "2Gi"}


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


def test_syncs_always_use_the_sync_user(charts: dict[str, dict]) -> None:
    default = charts["defaults"]
    reconcile = default["CronWorkflow", "contract-reconcile-loop"]
    env = reconcile["spec"]["workflowSpec"]["templates"][0]["container"]["env"]
    assert {"name": "RECONCILE_DEST_CLICKHOUSE_USERNAME", "value": "insight_sync"} in env
    assert {"name": "RECONCILE_SYNC_PASSWORD_SECRET", "value": "insight-db-creds"} in env
    assert {"name": "RECONCILE_SYNC_PASSWORD_KEY", "value": "clickhouse-sync-password"} in env
    assert not {entry["name"] for entry in env} & {"RECONCILE_DEST_CLICKHOUSE_PASSWORD", "RECONCILE_SYNC_USER_ENABLED"}
    assert {"name": "RECONCILE_SWEEP_CLICKHOUSE_USERNAME", "value": "test"} in env
    assert {
        "name": "RECONCILE_SWEEP_CLICKHOUSE_PASSWORD",
        "valueFrom": {"secretKeyRef": {"name": "insight-db-creds", "key": "clickhouse-password"}},
    } in env
    assert ("ConfigMap", "contract-reconcile-destinations") in default
    password = default["Secret", "insight-db-creds"]["stringData"]["clickhouse-sync-password"]
    assert len(password) == 24
    assert password != default["Secret", "insight-db-creds"]["stringData"]["clickhouse-password"]
    jobs = {
        name: {entry["name"]: entry for entry in job["spec"]["template"]["spec"]["containers"][0]["env"]}
        for (kind, name), job in default.items()
        if kind == "Job" and name.endswith(("clickhouse-databases", "clickhouse-migrate"))
    }
    bootstrap = default["Secret", "contract-clickhouse-sync-bootstrap"]
    assert bootstrap["stringData"] == {"password": password}
    assert bootstrap["metadata"]["annotations"]["helm.sh/hook"] == "pre-install,pre-upgrade"
    databases = default["Job", "contract-clickhouse-databases"]["metadata"]["annotations"]
    assert "pre-install" in databases["helm.sh/hook"]
    assert int(bootstrap["metadata"]["annotations"]["helm.sh/hook-weight"]) < int(databases["helm.sh/hook-weight"])
    reference = {"secretKeyRef": {"name": "contract-clickhouse-sync-bootstrap", "key": "password", "optional": True}}
    assert len(jobs) == 2
    for job in jobs.values():
        assert job["CLICKHOUSE_SYNC_USER"]["value"] == "insight_sync"
        assert job["CLICKHOUSE_SYNC_PASSWORD"]["valueFrom"] == reference
        assert "CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES" not in job

    for provision in (True, False):
        args = [
            "--set",
            "clickhouse.syncUser.username=etl,clickhouse.syncUser.passwordSecret.name=etl-credentials,clickhouse.syncUser.passwordSecret.key=etl-password,clickhouse.syncUser.totalMemoryBytes=12884901888",
            "--set",
            f"clickhouse.provisionAccess={str(provision).lower()}",
        ]
        chart = render(*args)
        assert "clickhouse-sync-password" not in chart["Secret", "insight-db-creds"]["stringData"]
        assert ("Secret", "contract-clickhouse-sync-bootstrap") not in chart
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
        env = {entry["name"]: entry for entry in ddl["spec"]["template"]["spec"]["containers"][0]["env"]}
        assert ("CLICKHOUSE_SYNC_PASSWORD" in env) == provision
        if provision:
            assert env["CLICKHOUSE_SYNC_PASSWORD"]["valueFrom"]["secretKeyRef"]["name"] == "etl-credentials"
            assert env["CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES"]["value"] == "12884901888"
        for service, key in [("analytics", "analytics"), ("identity-resolution", "identity_resolution")]:
            field = f"APP__gears__{key}__config__clickhouse_user"
            assert chart["Secret", f"insight-{service}-config"]["stringData"][field] == "test"


def test_operator_credentials_carry_the_sync_password() -> None:
    chart = render("--set", "credentials.autoGenerate=false")
    assert ("Secret", "insight-db-creds") not in chart
    assert ("Secret", "contract-clickhouse-sync-bootstrap") not in chart
    env = templates(chart, "dbt-run")["run"]["script"]["env"]
    assert {
        "name": "CLICKHOUSE_PASSWORD",
        "valueFrom": {"secretKeyRef": {"name": "insight-db-creds", "key": "clickhouse-sync-password"}},
    } in env
    ddl = chart["Job", "contract-clickhouse-databases"]["spec"]["template"]["spec"]["containers"][0]["env"]
    assert {
        "name": "CLICKHOUSE_SYNC_PASSWORD",
        "valueFrom": {
            "secretKeyRef": {"name": "insight-db-creds", "key": "clickhouse-sync-password", "optional": True}
        },
    } in ddl


def test_a_release_that_creates_no_users_never_generates_the_sync_password() -> None:
    chart = render("--set", "clickhouse.provisionAccess=false")
    assert "clickhouse-sync-password" not in chart["Secret", "insight-db-creds"]["stringData"]
    assert ("Secret", "contract-clickhouse-sync-bootstrap") not in chart


@pytest.mark.parametrize("exit_code", [42, 43, 44, 45])
def test_airbyte_launch_does_not_retry_terminal_exit_codes(charts: dict[str, dict], exit_code: int) -> None:
    trigger = templates(charts["defaults"], "airbyte-sync")["trigger-sync"]
    assert f"lastRetry.exitCode != '{exit_code}'" in trigger["retryStrategy"]["expression"].split(" && ")


@pytest.mark.parametrize("username", ["test", "default", "presentation", "grafana", "insight_mcp", "insight_v3_reader"])
def test_sync_user_must_have_a_dedicated_name(charts: dict[str, dict], username: str) -> None:
    with pytest.raises(subprocess.CalledProcessError) as error:
        render("--set", f"clickhouse.syncUser.username={username}")
    assert "clickhouse.syncUser.username must name a dedicated ClickHouse user" in error.value.stderr


def test_sync_user_name_is_required(charts: dict[str, dict]) -> None:
    with pytest.raises(subprocess.CalledProcessError) as error:
        render("--set", "clickhouse.syncUser.username=")
    assert "syncUser" in error.value.stderr


def test_sync_user_provisioning_requires_a_job(charts: dict[str, dict]) -> None:
    with pytest.raises(subprocess.CalledProcessError) as error:
        render(
            "--set", "clickhouse.provisionAccess=true,clickhouse.createDatabases=false,clickhouse.runMigrations=false"
        )
    assert "requires ingestion.toolboxImage and a ClickHouse provisioning job" in error.value.stderr


def test_memory_byte_values_from_a_values_file_render_as_integers(tmp_path: Path) -> None:
    values = tmp_path / "sync.yaml"
    values.write_text("clickhouse:\n  syncUser:\n    totalMemoryBytes: 12884901888\n    queryMemoryBytes: 1073741824\n")
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


def render(*args: str) -> dict[tuple[str, str], dict]:
    result = subprocess.run(
        ["helm", "template", "contract", str(CHART), "-f", str(CHART / "tests/values.yaml"), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return {(doc["kind"], doc["metadata"]["name"]): doc for doc in yaml.safe_load_all(result.stdout) if doc}


def test_pipeline_passes_pod_patches_by_plain_substitution(
    charts: dict[str, dict], resource_parameter_names: dict[str, str]
) -> None:
    for path in (CHART / "templates/ingestion").rglob("*"):
        if path.is_file():
            assert "{{=" not in path.read_text(), path.name

    sync = resource_parameter_names["sync"]
    consumers = {
        "dbt-run": resource_parameter_names["dbt"],
        "connector-checks": resource_parameter_names["dbt"],
        "identity-seed-run": resource_parameter_names["identity"],
    }
    names = set(resource_parameter_names.values())
    assert len(names) == 3
    task_inputs = {workflow: {sync, patch} for workflow, patch in consumers.items()}
    task_inputs.update({"transform": names, "airbyte-sync": {sync}})

    for chart in charts.values():
        for workflow, patch in consumers.items():
            run = templates(chart, workflow)["run"]
            assert run["podSpecPatch"] == "{{inputs.parameters." + patch + "}}", workflow
            inputs = [(p["name"], p.get("default")) for p in run["inputs"]["parameters"] if p["name"] in names]
            assert sorted(inputs) == sorted((name, "{}") for name in task_inputs[workflow]), workflow

        pipeline = templates(chart, "ingestion-pipeline")
        for entrypoint, spec in pipeline.items():
            inputs = [(p["name"], p.get("default")) for p in spec["inputs"]["parameters"] if p["name"] in names]
            assert sorted(inputs) == sorted((name, "{}") for name in names), entrypoint
            for task in spec["dag"]["tasks"]:
                consumer = task["templateRef"]["name"] if "templateRef" in task else task["template"]
                arguments = [(p["name"], p["value"]) for p in task["arguments"]["parameters"] if p["name"] in names]
                expected = [(name, "{{inputs.parameters." + name + "}}") for name in task_inputs[consumer]]
                assert sorted(arguments) == sorted(expected), task["name"]


def test_connector_resources_reach_airbyte_and_the_reconcile_submission(
    charts: dict[str, dict], resource_parameter_names: dict[str, str]
) -> None:
    sync = resource_parameter_names["sync"]
    chart = charts["overrides"]
    bronze = templates(chart, "airbyte-sync")
    trigger_env = {item["name"]: item.get("value") for item in bronze["trigger-sync"]["container"]["env"]}
    poll_env = {item["name"]: item.get("value") for item in bronze["poll-job"]["container"]["env"]}
    assert trigger_env["SYNC_RESOURCES"] == "{{inputs.parameters." + sync + "}}"
    assert poll_env["SYNC_RESOURCES"] == trigger_env["SYNC_RESOURCES"]
    poll_step = bronze["sync"]["steps"][1][0]
    arguments = {item["name"]: item["value"] for item in poll_step["arguments"]["parameters"]}
    assert arguments[sync] == trigger_env["SYNC_RESOURCES"]
    assert "AIRBYTE_RESOURCE_JOURNAL" not in trigger_env.keys() | poll_env.keys()
    reconcile = chart["CronWorkflow", "contract-reconcile-loop"]
    env = reconcile["spec"]["workflowSpec"]["templates"][0]["container"]["env"]
    defaults = next(item["value"] for item in env if item["name"] == "CONNECTOR_RESOURCE_DEFAULTS")
    assert json.loads(defaults) == {
        "airbyte_cpu_millis": 1000,
        "airbyte_memory_bytes": 1073741824,
        "dbt_cpu_millis": 2000,
        "dbt_memory_bytes": 2147483648,
        "identity_cpu_millis": 250,
        "identity_memory_bytes": 536870912,
        "dbt_query_memory_bytes": 5368709120,
    }
