from __future__ import annotations

import base64
import json
import shutil
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
        renders[release] = render(*options)
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
    chart = render("--set", "ingestion.airbyteSync.capacityCheck.enabled=false")
    name = templates(chart, "airbyte-sync")["poll-job"]["serviceAccountName"]
    assert charts["defaults"]["Role", name]["rules"][:2] == chart["Role", name]["rules"]
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
    lease = "contract-airbyte-capacity"
    assert all((kind, lease) not in chart for kind in ("Deployment", "Service", "ServiceAccount"))
    trigger_account = trigger["serviceAccountName"]
    assert trigger_account == airbyte["poll-job"]["serviceAccountName"] == "contract-airbyte-trigger"
    assert chart["Role", trigger_account]["rules"][2:] == [
        {
            "apiGroups": ["coordination.k8s.io"],
            "resources": ["leases"],
            "resourceNames": [lease],
            "verbs": ["get", "patch"],
        }
    ]
    assert airbyte["resolve-connection-by-name"].get("serviceAccountName") != trigger_account
    assert ("Lease", lease) in chart
    env = {item["name"]: item for item in trigger["container"]["env"]}
    poll_env = {item["name"]: item for item in airbyte["poll-job"]["container"]["env"]}
    capacity_keys = {
        "AIRBYTE_CAPACITY_CHECK_ENABLED",
        "AIRBYTE_CAPACITY_SETTINGS",
        "AIRBYTE_CAPACITY_LEASE",
        "AIRBYTE_CAPACITY_NAMESPACES",
        "POD_UID",
    }
    for step_env in (env, poll_env):
        assert {name for name in step_env if name.startswith("AIRBYTE_CAPACITY_") or name == "POD_UID"} == capacity_keys
    assert {name: env[name] for name in capacity_keys} == {name: poll_env[name] for name in capacity_keys}
    assert env["AIRBYTE_CAPACITY_CHECK_ENABLED"]["value"] == "true"
    assert env["AIRBYTE_CAPACITY_LEASE"]["value"] == lease
    assert env["AIRBYTE_CAPACITY_NAMESPACES"]["value"] == "default"
    assert env["POD_UID"]["valueFrom"]["fieldRef"]["fieldPath"] == "metadata.uid"
    assert json.loads(env["AIRBYTE_CAPACITY_SETTINGS"]["value"]) == {
        "nodeSelector": {},
        "tolerations": [],
        "pendingMaxAgeSeconds": 1800,
        "waitLimitSeconds": 21600,
        "requests": {
            "orchestrator": {"cpu": "1", "memory": "2Gi"},
            "source": {"cpu": "1", "memory": "2Gi"},
            "destination": {"cpu": "500m", "memory": "1Gi"},
            "init": {"cpu": "1", "memory": "2Gi"},
        },
    }

    disabled = render("--set", "ingestion.airbyteSync.capacityCheck.enabled=false")
    assert all("airbyte-capacity" not in name for _, name in disabled)
    airbyte = templates(disabled, "airbyte-sync")
    assert airbyte["trigger-sync"]["serviceAccountName"] == airbyte["poll-job"]["serviceAccountName"]
    for step in ("trigger-sync", "poll-job"):
        assert all(not item["name"].startswith("AIRBYTE_CAPACITY_") for item in airbyte[step]["container"]["env"])
    assert all(item["name"] != "SYNC_RESOURCES" for item in airbyte["poll-job"]["container"]["env"])

    tolerations = [{"key": "dedicated", "value": "jobs", "effect": "NoSchedule"}]
    override = render(
        "--set-string",
        "ingestion.airbyteSync.capacityCheck.nodeSelector.pool=jobs",
        "--set-string",
        "ingestion.airbyteSync.capacityCheck.requests.source.cpu=1500m",
        "--set-json",
        f"ingestion.airbyteSync.capacityCheck.tolerations={json.dumps(tolerations)}",
        "--set",
        "ingestion.airbyteSync.capacityCheck.pendingMaxAgeSeconds=300,ingestion.airbyteSync.capacityCheck.waitLimitSeconds=900",
    )
    separate_release = render("--set-string", "fullnameOverride=another")
    assert ("Lease", "another-airbyte-capacity") in separate_release and ("Lease", lease) not in separate_release

    for step in ("trigger-sync", "poll-job"):
        step_env = templates(override, "airbyte-sync")[step]["container"]["env"]
        settings = json.loads(next(item["value"] for item in step_env if item["name"] == "AIRBYTE_CAPACITY_SETTINGS"))
        assert settings["nodeSelector"] == {"pool": "jobs"}
        assert settings["tolerations"] == tolerations
        assert settings["pendingMaxAgeSeconds"] == 300
        assert settings["waitLimitSeconds"] == 900
        assert settings["requests"]["source"] == {"cpu": "1500m", "memory": "2Gi"}
    connector_config = yaml.safe_load(
        charts["overrides"]["ConfigMap", "contract-connectors-gears-config"]["data"]["insight.yaml"]
    )
    source = connector_config["gears"]["connectors"]["config"]["airbyte_placement"]["requests"]["source"]
    assert source == {"cpu": "1000m", "memory": "1073741824"}


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
    databases = default["Job", "contract-clickhouse-databases"]["metadata"]["annotations"]
    assert "pre-install" in databases["helm.sh/hook"]
    assert int(bootstrap["metadata"]["annotations"]["helm.sh/hook-weight"]) < int(databases["helm.sh/hook-weight"])
    delete_policy = bootstrap["metadata"]["annotations"]["helm.sh/hook-delete-policy"].split(",")
    assert "hook-succeeded" in delete_policy
    assert set(jobs) == {"contract-clickhouse-databases", "contract-clickhouse-migrate"}
    for name, job in jobs.items():
        assert job["CLICKHOUSE_SYNC_USER"]["value"] == "insight_sync"
        ref = job["CLICKHOUSE_SYNC_PASSWORD"]["valueFrom"]["secretKeyRef"]
        if name.endswith("clickhouse-databases"):
            assert ref == {"name": "contract-clickhouse-sync-bootstrap", "key": "password", "optional": True}
        else:
            assert ref == {"name": "insight-db-creds", "key": "clickhouse-sync-password", "optional": True}
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


@pytest.mark.parametrize(
    ("resource", "phases"),
    [
        (("Secret", "contract-clickhouse-sync-bootstrap"), "pre-install,pre-upgrade"),
        (("Job", "contract-clickhouse-databases"), "pre-install,pre-upgrade"),
        (("Job", "contract-clickhouse-migrate"), "post-install,post-upgrade"),
    ],
)
def test_sync_password_hooks_never_run_on_rollback(
    charts: dict[str, dict], resource: tuple[str, str], phases: str
) -> None:
    annotations = charts["defaults"][resource]["metadata"]["annotations"]
    assert annotations["helm.sh/hook"] == phases, resource


@pytest.fixture
def lookup_chart(tmp_path: Path, charts: dict[str, dict]) -> Path:
    return shutil.copytree(CHART, tmp_path / "insight")


def substitute_sync_secret(
    chart: Path, data: dict[str, str], *, name: str = "insight-db-creds", managed: bool = True
) -> None:
    labels = {"app.kubernetes.io/managed-by": "Helm"}
    metadata = {"labels": labels if managed else {}}
    default_data = datastore_credentials() | {"example-key": base64.b64encode(b"unrelated-example-password").decode()}
    secrets = {
        "insight-db-creds": {"metadata": {"labels": labels}, "data": default_data},
        name: {"metadata": metadata, "data": data},
    }
    lookups = f"({json.dumps(json.dumps(secrets))} | fromJson)"
    for filename, refs in (("secrets.yaml", ("$syncRef.name", '"insight-db-creds"')), ("_helpers.tpl", ("$ref.name",))):
        template = chart / "templates" / filename
        source = template.read_text()
        for ref in refs:
            source = source.replace(f'lookup "v1" "Secret" .Release.Namespace {ref}', f"(get {lookups} {ref})")
        template.write_text(source)


@pytest.mark.parametrize("value", [None, ""])
@pytest.mark.parametrize(
    ("auto", "provision", "managed", "name", "key"),
    [
        (False, False, False, "insight-db-creds", "clickhouse-sync-password"),
        (False, True, False, "insight-db-creds", "clickhouse-sync-password"),
        (True, False, True, "insight-db-creds", "clickhouse-sync-password"),
        (True, True, False, "insight-db-creds", "clickhouse-sync-password"),
        (True, True, True, "example-sync-credentials", "example-key"),
    ],
)
def test_existing_secret_requires_a_sync_password_when_helm_does_not_generate_it(
    lookup_chart: Path, auto: bool, provision: bool, managed: bool, name: str, key: str, value: str | None
) -> None:
    data = datastore_credentials()
    if value is not None:
        data[key] = value
    substitute_sync_secret(lookup_chart, data, name=name, managed=managed)

    with pytest.raises(subprocess.CalledProcessError) as error:
        render(
            "--set",
            f"credentials.autoGenerate={str(auto).lower()},clickhouse.provisionAccess={str(provision).lower()}",
            "--set",
            f"clickhouse.syncUser.passwordSecret.name={name},clickhouse.syncUser.passwordSecret.key={key}",
            chart=lookup_chart,
        )
    assert f'Secret "{name}" requires a non-empty "{key}" key. Add the key before the upgrade.' in error.value.stderr


def datastore_credentials() -> dict[str, str]:
    keys = ("clickhouse-password", "mariadb-password", "mariadb-root-password", "redis-password")
    return dict.fromkeys(keys, base64.b64encode(b"example-password").decode())


@pytest.mark.parametrize("password", [None, "example-existing-password"])
def test_helm_resolves_the_sync_password_for_an_existing_managed_secret(
    lookup_chart: Path, password: str | None
) -> None:
    data = datastore_credentials()
    if password is not None:
        data["clickhouse-sync-password"] = base64.b64encode(password.encode()).decode()
    substitute_sync_secret(lookup_chart, data)

    resources = render(chart=lookup_chart)
    result = resources["Secret", "insight-db-creds"]["stringData"]["clickhouse-sync-password"]
    assert result == password if password is not None else len(result) == 24
    bootstrap = ("Secret", "contract-clickhouse-sync-bootstrap")
    job = resources["Job", "contract-clickhouse-databases"]
    env = job["spec"]["template"]["spec"]["containers"][0]["env"]
    password_ref = next(item["valueFrom"]["secretKeyRef"] for item in env if item["name"] == "CLICKHOUSE_SYNC_PASSWORD")
    if password is None:
        assert resources[bootstrap]["stringData"]["password"] == result
        assert password_ref == {"name": bootstrap[1], "key": "password", "optional": True}
    else:
        assert bootstrap not in resources
        assert password_ref == {"name": "insight-db-creds", "key": "clickhouse-sync-password", "optional": True}


@pytest.mark.parametrize("exit_code", [42, 43, 44, 45, 46, 47])
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


def render(*args: str, chart: Path = CHART) -> dict[tuple[str, str], dict]:
    return {(doc["kind"], doc["metadata"]["name"]): doc for doc in render_docs(*args, chart=chart)}


def render_docs(*args: str, chart: Path = CHART, release: str = "contract") -> list[dict]:
    result = subprocess.run(
        ["helm", "template", release, str(chart), "-f", str(chart / "tests/values.yaml"), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


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


def test_capacity_rbac_grants_the_launch_steps_only_nodes_and_allowlisted_pods() -> None:
    for args, expected in [
        ([], {"default", "example-airbyte"}),
        (
            ["--set", "ingestion.airbyteSync.capacityCheck.podNamespaces={example-airbyte,example-datastores}"],
            {"example-airbyte", "example-datastores"},
        ),
    ]:
        docs = render_docs("--set", "airbyte.namespace=example-airbyte", *args)
        subject = {"kind": "ServiceAccount", "name": "contract-airbyte-trigger", "namespace": "default"}
        role_name = "contract-airbyte-capacity.default"
        assert all(
            not {"pods", "*"} & set(rule.get("resources", []))
            for doc in docs
            if doc["kind"] == "ClusterRole"
            for rule in doc["rules"]
        )
        cluster_roles = {doc["metadata"]["name"]: doc["rules"] for doc in docs if doc["kind"] == "ClusterRole"}
        bindings = [doc for doc in docs if doc["kind"] == "ClusterRoleBinding" and subject in doc["subjects"]]
        assert len(bindings) == 1
        assert bindings[0]["subjects"] == [subject]
        assert bindings[0]["roleRef"] == {
            "apiGroup": "rbac.authorization.k8s.io",
            "kind": "ClusterRole",
            "name": role_name,
        }
        assert cluster_roles[role_name] == [{"apiGroups": [""], "resources": ["nodes"], "verbs": ["get", "list"]}]
        pod_rule = {"apiGroups": [""], "resources": ["pods"], "verbs": ["list"]}
        roles = [doc for doc in docs if doc["kind"] == "Role" and doc["metadata"]["name"] == role_name]
        assert sorted(doc["metadata"]["namespace"] for doc in roles) == sorted(expected)
        assert all(doc["rules"] == [pod_rule] for doc in roles)
        pod_bindings = [doc for doc in docs if doc["kind"] == "RoleBinding" and doc["roleRef"]["name"] == role_name]
        assert sorted(doc["metadata"]["namespace"] for doc in pod_bindings) == sorted(expected)
        for binding in pod_bindings:
            assert binding["subjects"] == [subject]
            assert binding["roleRef"] == {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": role_name}


def test_workflow_admission_policy_renders_without_api_discovery() -> None:
    name = "contract-airbyte-trigger.default"
    resources = render()
    policy = ("ValidatingAdmissionPolicy", name)
    binding = ("ValidatingAdmissionPolicyBinding", name)
    assert resources[binding]["apiVersion"] == resources[policy]["apiVersion"] == "admissionregistration.k8s.io/v1"
    assert resources[binding]["spec"] == {"policyName": name, "validationActions": ["Deny"]}
    assert resources[policy]["spec"]["failurePolicy"] == "Fail"
    assert "authentication.kubernetes.io/pod-name" in str(resources[policy]["spec"]["variables"])
    assert "workflows" in resources[policy]["spec"]["matchConstraints"]["resourceRules"][0]["resources"]


@pytest.mark.parametrize("key", ["managePlatformAccess", "airbyteSync.allowWorkflowPatchWithoutPolicy"])
def test_removed_ingestion_access_values_are_rejected_by_schema(key: str) -> None:
    with pytest.raises(subprocess.CalledProcessError) as error:
        render_docs("--set", f"ingestion.{key}=true")
    assert "values" in error.value.stderr
    assert key.rsplit(".", 1)[-1] in error.value.stderr


def test_unrelated_ingestion_values_can_render() -> None:
    chart = render("--set", "ingestion.exampleExtension=true,ingestion.airbyteSync.exampleExtension=true")

    assert ("WorkflowTemplate", "airbyte-sync") in chart


@pytest.mark.parametrize("runs", [1_000_000, 4_294_967_295])
def test_connectors_run_history_renders_as_an_integer(runs: int) -> None:
    chart = render("--set-json", f"connectors.runHistory.runsPerInstance={runs}")
    config = yaml.safe_load(chart["ConfigMap", "contract-connectors-gears-config"]["data"]["insight.yaml"])
    rendered_runs = config["gears"]["connectors"]["config"]["history_runs_per_instance"]

    assert type(rendered_runs) is int
    assert rendered_runs == runs


def test_connectors_platform_access_renders_without_api_discovery() -> None:
    docs = render_docs("--set", "airbyte.namespace=example-airbyte")
    resources = {(doc["kind"], doc["metadata"]["name"]): doc for doc in docs}
    cluster_name = "contract-connectors.default"
    observer_name = "default-contract-connectors-observer"
    subject = {"kind": "ServiceAccount", "name": "contract-connectors", "namespace": "default"}
    assert resources["ClusterRole", cluster_name]["rules"] == [
        {"apiGroups": [""], "resources": ["nodes"], "verbs": ["get", "list"]}
    ]
    observer = resources["Role", observer_name]
    assert observer["metadata"]["namespace"] == "example-airbyte"
    assert observer["rules"] == [
        {"apiGroups": [""], "resources": ["pods"], "verbs": ["list"]},
        {"apiGroups": [""], "resources": ["secrets"], "resourceNames": ["airbyte-auth-secrets"], "verbs": ["get"]},
    ]
    for kind, name in [("ClusterRole", cluster_name), ("Role", observer_name)]:
        binding = resources[f"{kind}Binding", name]
        assert binding["subjects"] == [subject]
        assert binding["roleRef"] == {"apiGroup": "rbac.authorization.k8s.io", "kind": kind, "name": name}
    assert resources["RoleBinding", observer_name]["metadata"]["namespace"] == "example-airbyte"


@pytest.mark.parametrize(
    ("role_kind", "role_name", "namespace", "managed_kinds", "delegated"),
    [
        (
            "ClusterRole",
            "ci-deployer-ingestion-admission.insight",
            None,
            {
                "ClusterRole": "clusterroles",
                "ClusterRoleBinding": "clusterrolebindings",
                "ValidatingAdmissionPolicy": "validatingadmissionpolicies",
                "ValidatingAdmissionPolicyBinding": "validatingadmissionpolicybindings",
            },
            [{"apiGroups": [""], "resources": ["nodes"], "verbs": ["get", "list"]}],
        ),
        (
            "Role",
            "ci-deployer-airbyte.insight",
            "airbyte",
            {"Role": "roles", "RoleBinding": "rolebindings"},
            [
                {"apiGroups": [""], "resources": ["pods"], "verbs": ["list"]},
                {
                    "apiGroups": [""],
                    "resources": ["secrets"],
                    "resourceNames": ["airbyte-auth-secrets"],
                    "verbs": ["get"],
                },
            ],
        ),
    ],
    ids=["cluster", "airbyte"],
)
def test_ci_deployer_can_manage_only_named_platform_resources_after_create(
    role_kind: str, role_name: str, namespace: str | None, managed_kinds: dict[str, str], delegated: list[dict]
) -> None:
    docs = render_docs("--namespace", "insight", "--set", "airbyte.namespace=airbyte", release="insight")
    ci = CHART.parents[1] / "deploy/gitops/environments/test-stand/ci-deployer-rbac.yaml"
    rbac = {(doc["kind"], doc["metadata"]["name"]): doc for doc in yaml.safe_load_all(ci.read_text())}
    role = rbac[role_kind, role_name]
    binding = rbac[f"{role_kind}Binding", role_name]
    assert role["metadata"].get("namespace") == binding["metadata"].get("namespace") == namespace
    assert binding["subjects"] == [{"kind": "ServiceAccount", "name": "ci-deployer", "namespace": "insight"}]
    assert binding["roleRef"] == {"apiGroup": "rbac.authorization.k8s.io", "kind": role_kind, "name": role_name}

    expected = delegated.copy()
    for kind, resource in managed_kinds.items():
        rendered = [doc for doc in docs if doc["kind"] == kind and doc["metadata"].get("namespace") == namespace]
        assert rendered, kind
        api_groups = [rendered[0]["apiVersion"].split("/")[0]]
        names = sorted(doc["metadata"]["name"] for doc in rendered)
        expected.append({"apiGroups": api_groups, "resources": [resource], "verbs": ["create"]})
        expected.append(
            {
                "apiGroups": api_groups,
                "resources": [resource],
                "resourceNames": names,
                "verbs": ["get", "update", "patch", "delete"],
            }
        )

    actual = [{**rule, "resources": [resource]} for rule in role["rules"] for resource in rule["resources"]]
    assert len(actual) == len(expected)
    for rule in expected:
        assert rule in actual, rule
    for doc in docs:
        if doc["kind"] != role_kind or doc["metadata"].get("namespace") != namespace:
            continue
        assert all(rule in delegated for rule in doc["rules"])


def test_ci_deployer_can_manage_the_capacity_lease() -> None:
    ci = CHART.parents[1] / "deploy/gitops/environments/test-stand/ci-deployer-rbac.yaml"
    core = next(doc for doc in yaml.safe_load_all(ci.read_text()) if doc["metadata"]["name"] == "ci-deployer-core")
    leases = next(rule for rule in core["rules"] if rule["resources"] == ["leases"])
    assert set(leases["verbs"]) >= {"create", "get", "patch", "update", "delete"}


def test_only_the_bootstrap_secret_hook_manages_its_lifecycle() -> None:
    resources = render()
    secret = resources["Secret", "contract-clickhouse-sync-bootstrap"]
    assert "hook-succeeded" in secret["metadata"]["annotations"]["helm.sh/hook-delete-policy"].split(",")
    name = "contract-clickhouse-bootstrap-cleanup"
    assert all((kind, name) not in resources for kind in ("Job", "ServiceAccount", "Role", "RoleBinding"))
