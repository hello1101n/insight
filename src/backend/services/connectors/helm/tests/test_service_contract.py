from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

from .conftest import CONNECTORS_CHART, connectors_documents, render_connectors


def workload(documents: list[dict], kind: str) -> dict:
    return next(
        doc for doc in documents if doc["kind"] == kind and doc["metadata"]["name"] == "contract-test-connectors"
    )


def test_single_replica_recreates_with_its_service_account() -> None:
    documents = connectors_documents(CONNECTORS_CHART)
    deployment = workload(documents, "Deployment")
    assert deployment["spec"]["replicas"] == 1
    assert deployment["spec"]["strategy"] == {"type": "Recreate"}
    assert deployment["spec"]["template"]["spec"]["serviceAccountName"] == "contract-test-connectors"
    assert workload(documents, "Service")["spec"]["ports"][0]["port"] == 8088
    assert workload(documents, "ServiceAccount")["automountServiceAccountToken"] is True


@pytest.mark.parametrize("replicas", ["0", "2", "1.5", "invalid"])
def test_replica_count_other_than_one_is_refused(replicas: str) -> None:
    result = render_connectors(CONNECTORS_CHART, "--set", f"replicaCount={replicas}")
    assert result.returncode != 0, f"should reject replicaCount={replicas}"
    assert "must be exactly 1" in result.stderr


def test_migrate_runs_before_install_without_release_config_resources() -> None:
    documents = connectors_documents(CONNECTORS_CHART)
    job = next(doc for doc in documents if doc["kind"] == "Job")
    assert job["metadata"]["annotations"]["helm.sh/hook"] == "pre-install,pre-upgrade"
    assert job["metadata"]["annotations"]["helm.sh/hook-weight"] == "10"
    pod = job["spec"]["template"]["spec"]
    assert "serviceAccountName" not in pod
    assert "configMap" not in str(pod)
    command = pod["containers"][0]["command"][-1]
    assert "home_dir: /tmp/gears" in command
    assert "exec /app/connectors -c /tmp/migrate.yaml migrate" in command
    assert not any(doc["kind"] == "Secret" for doc in documents)


@pytest.mark.parametrize("umbrella", [False, True], ids=["standalone", "umbrella"])
def test_workload_selectors_match_only_the_serving_pod(connectors_umbrella: Path, umbrella: bool) -> None:
    chart = connectors_umbrella if umbrella else CONNECTORS_CHART
    extra = ["-f", str(connectors_umbrella / "tests/values.yaml")] if umbrella else []
    documents = connectors_documents(chart, *extra)
    deployment = workload(documents, "Deployment")
    job = next(
        doc
        for doc in documents
        if doc["kind"] == "Job" and doc["metadata"]["name"] == "contract-test-connectors-migrate"
    )
    serving_labels = deployment["spec"]["template"]["metadata"]["labels"]
    migration_labels = job["spec"]["template"]["metadata"]["labels"]
    selectors = {
        "Service": workload(documents, "Service")["spec"]["selector"],
        "Deployment": deployment["spec"]["selector"]["matchLabels"],
    }
    for kind, selector in selectors.items():
        assert selector
        assert selector.items() <= serving_labels.items(), f"{kind} must select the serving pod"
        assert not selector.items() <= migration_labels.items(), f"{kind} must not select the migration pod"

    assert migration_labels["app.kubernetes.io/component"] == "migrate"
    assert migration_labels["app.kubernetes.io/instance"] == "contract-test"


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        (["--set-string", "identityUrl=https://identity.example.test:8082"], "https://identity.example.test:8082"),
        ([], "http://contract-test-identity-resolution:8082"),
        (["--set-string", "identityUrl="], "http://contract-test-identity-resolution:8082"),
        (
            ["--set-string", "identityUrl=", "--set-string", "connectors.identityUrl=https://identity.example.test"],
            "https://identity.example.test",
        ),
    ],
    ids=["override", "unset", "empty", "empty-keeps-subchart-override"],
)
def test_umbrella_identity_url_override_preserves_subchart_fallback(
    connectors_umbrella: Path, overrides: list[str], expected: str
) -> None:
    documents = connectors_documents(
        connectors_umbrella, "-f", str(connectors_umbrella / "tests/values.yaml"), *overrides
    )
    container = workload(documents, "Deployment")["spec"]["template"]["spec"]["containers"][0]
    identity_env = next(
        entry for entry in container["env"] if entry["name"] == "APP__gears__connectors__config__identity_url"
    )
    assert identity_env["value"] == expected


def test_service_route_and_database_always_render(connectors_umbrella: Path) -> None:
    documents = connectors_documents(connectors_umbrella, "-f", str(connectors_umbrella / "tests/values.yaml"))
    deployments = {doc["metadata"]["name"] for doc in documents if doc["kind"] == "Deployment"}
    assert "contract-test-connectors" in deployments
    services = {doc["metadata"]["name"] for doc in documents if doc["kind"] == "Service"}
    assert "contract-test-connectors" in services
    route_config = next(
        doc
        for doc in documents
        if doc["kind"] == "ConfigMap" and doc["metadata"]["name"] == "contract-test-gateway-routes"
    )
    routes = yaml.safe_load(route_config["data"]["routes.yaml"])["routes"]
    connector_routes = [route for route in routes if route["prefix"] == "/api/connectors"]
    assert len(connector_routes) == 1
    assert connector_routes[0] == {
        "prefix": "/api/connectors",
        "upstream": "http://contract-test-connectors:8088",
        "strip_prefix": True,
        "timeout_ms": 135000,
    }
    jobs = [doc for doc in documents if doc["kind"] == "Job"]
    assert any(doc["metadata"]["name"] == "contract-test-connectors-migrate" for doc in jobs)
    provisioner = next(doc for doc in jobs if doc["metadata"]["name"].endswith("mariadb-init-svcdbs"))
    script = provisioner["spec"]["template"]["spec"]["containers"][0]["command"][-1]
    assert 'CONNECTORS_DB="connectors"' in script


def test_umbrella_uses_existing_password_secrets_for_both_workloads(connectors_umbrella: Path) -> None:
    documents = connectors_documents(
        connectors_umbrella,
        "-f",
        str(connectors_umbrella / "tests/values.yaml"),
        "--set",
        "credentials.autoGenerate=false",
        "--set",
        "authenticator.oidc.defaultTenantId=11111111-2222-4333-8444-555555555555",
        "--set",
        "mariadb.host=database.example.test",
        "--set",
        "mariadb.port=3307",
        "--set",
        "mariadb.username=example-user",
        "--set",
        "mariadb.passwordSecret.name=example-db-creds",
        "--set",
        "mariadb.passwordSecret.key=example-db-password",
        "--set",
        "clickhouse.host=warehouse.example.test",
        "--set",
        "clickhouse.port=8124",
        "--set",
        "clickhouse.protocol=https",
        "--set",
        "clickhouse.username=example-reader",
        "--set",
        "clickhouse.passwordSecret.name=example-ch-creds",
        "--set",
        "clickhouse.passwordSecret.key=example-ch-password",
    )
    for kind, name in [("Deployment", "contract-test-connectors"), ("Job", "contract-test-connectors-migrate")]:
        doc = next(doc for doc in documents if doc["kind"] == kind and doc["metadata"]["name"] == name)
        container = doc["spec"]["template"]["spec"]["containers"][0]
        env = {item["name"].removeprefix("APP__gears__connectors__config__"): item for item in container["env"]}
        assert env["database_host"]["value"] == "database.example.test"
        assert env["database_port"]["value"] == "3307"
        assert env["database_user"]["value"] == "example-user"
        assert env["database_name"]["value"] == "connectors"
        assert env["database_password"]["valueFrom"]["secretKeyRef"] == {
            "name": "example-db-creds",
            "key": "example-db-password",
        }
        assert "database_url" not in env
        assert "envFrom" not in container or all("secretRef" not in item for item in container["envFrom"])
        if kind == "Deployment":
            assert env["reconcile_workflow_name"]["value"] == "contract-test-reconcile-loop"
            assert env["tenant_id"]["value"] == "11111111-2222-4333-8444-555555555555"
            assert env["clickhouse_url"]["value"] == "https://warehouse.example.test:8124"
            assert env["clickhouse_user"]["value"] == "example-reader"
            assert env["clickhouse_password"]["valueFrom"]["secretKeyRef"] == {
                "name": "example-ch-creds",
                "key": "example-ch-password",
            }
            assert env["identity_url"]["value"] == "http://contract-test-identity-resolution:8082"


@pytest.mark.parametrize("auto_generate", [True, False])
def test_connectors_templates_render_no_secrets(connectors_umbrella: Path, auto_generate: bool) -> None:
    result = render_connectors(
        connectors_umbrella,
        "-f",
        str(connectors_umbrella / "tests/values.yaml"),
        "--set",
        f"credentials.autoGenerate={str(auto_generate).lower()}",
    )
    assert result.returncode == 0, result.stderr
    for manifest in re.split(r"^---\s*$", result.stdout, flags=re.MULTILINE):
        document = yaml.safe_load(manifest)
        if not document or document["kind"] != "Secret":
            continue

        source = next(
            line.removeprefix("# Source: ") for line in manifest.splitlines() if line.startswith("# Source: ")
        )
        assert source != "insight/templates/connectors.yaml", (source, document["metadata"]["name"])
        assert not source.startswith("insight/charts/connectors/"), (source, document["metadata"]["name"])


def test_gears_host_verifies_gateway_identity(connectors_umbrella: Path) -> None:
    documents = connectors_documents(
        connectors_umbrella,
        "-f",
        str(connectors_umbrella / "tests/values.yaml"),
        "--set",
        "global.observability.logs.level=debug",
        "--set",
        "global.observability.logs.format=pretty",
    )
    configmap = next(
        doc
        for doc in documents
        if doc["kind"] == "ConfigMap" and doc["metadata"]["name"] == "contract-test-connectors-gears-config"
    )
    config = yaml.safe_load(configmap["data"]["insight.yaml"])
    assert config["logging"]["default"] == {"console_level": "debug", "console_format": "pretty"}
    assert config["gears"]["connectors"]["config"]["cluster"]["enabled"] is True
    assert "drift" not in config["gears"]["connectors"]["config"]
    assert config["gears"]["connectors"]["config"]["namespace"] == "default"
    host = config["gears"]["api-gateway"]["config"]
    assert host["bind_addr"] == "0.0.0.0:8088"
    assert host["metrics"]["prefix"] == "host"
    assert host["auth_disabled"] is False
    jwt = config["gears"]["oidc-authn-plugin"]["config"]["jwt"]
    assert jwt["claim_mapping"]["subject_tenant_id"] == "tenant_id"
    assert jwt["trusted_issuers"][0]["issuer"] == "https://contract-test-authenticator.default.svc.cluster.local:8443"


def test_role_patches_schedules_and_stops_workflows_with_read_only_pod_access() -> None:
    documents = connectors_documents(CONNECTORS_CHART)
    assert workload(documents, "Role")["rules"] == [
        {"apiGroups": ["argoproj.io"], "resources": ["cronworkflows"], "verbs": ["get", "list", "watch", "patch"]},
        {"apiGroups": ["argoproj.io"], "resources": ["workflows"], "verbs": ["list", "watch", "patch"]},
        {"apiGroups": [""], "resources": ["pods"], "verbs": ["list"]},
    ]
    binding = workload(documents, "RoleBinding")
    assert binding["roleRef"] == {
        "apiGroup": "rbac.authorization.k8s.io",
        "kind": "Role",
        "name": "contract-test-connectors",
    }
    assert binding["subjects"] == [
        {"kind": "ServiceAccount", "name": "contract-test-connectors", "namespace": "default"}
    ]


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("tenant", ["", "example-tenant"])
def test_cluster_integration_requires_a_tenant_only_when_enabled(enabled: bool, tenant: str) -> None:
    result = render_connectors(
        CONNECTORS_CHART, "--set", f"cluster.enabled={str(enabled).lower()}", "--set-string", f"tenantId={tenant}"
    )
    if enabled and not tenant:
        assert result.returncode != 0
        assert "tenantId is required" in result.stderr
        return

    assert result.returncode == 0, result.stderr
    documents = [doc for doc in yaml.safe_load_all(result.stdout) if doc]
    configmap = next(doc for doc in documents if doc["kind"] == "ConfigMap")
    config = yaml.safe_load(configmap["data"]["insight.yaml"])["gears"]["connectors"]["config"]
    assert config["cluster"]["enabled"] is enabled
    container = workload(documents, "Deployment")["spec"]["template"]["spec"]["containers"][0]
    env = {entry["name"]: entry for entry in container["env"]}
    tenant_env = "APP__gears__connectors__config__tenant_id"
    if enabled:
        assert config["tenant_id"] == tenant
        assert env[tenant_env]["value"] == tenant
    else:
        assert "tenant_id" not in config
        assert tenant_env not in env
    for kind in ["Role", "RoleBinding"]:
        roles = [doc for doc in documents if doc["kind"] == kind]
        assert len(roles) == int(enabled)


def has_sleep_loop(source: str) -> bool:
    non_code = re.compile(
        r"""//[^\n]*|/\*.*?\*/|r(?P<hashes>#*)".*?"(?P=hashes)|"(?:\\.|[^"\\])*"|'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'""",
        re.S,
    )
    code = non_code.sub(" ", source)
    sleep_names = ["sleep", "sleep_until", *re.findall(r"\bsleep(?:_until)?\s+as\s+(\w+)", code)]
    sleep_call = re.compile(rf"\b(?:{'|'.join(sleep_names)})\s*\(")
    repetition = re.compile(
        r"\b(?:loop\s*|while\b[^;{}]*|for\b[^;{}]*\bin\b[^;{}]*)\{"
        r"|\.(?:try_)?for_each(?:_concurrent)?\s*\([^;{}]*\{"
        r"|\bfn\s+(?P<function>\w+)\b[^;{}]*\{"
    )
    braces = re.compile(r"[{}]")
    for block in re.finditer(rf"(?=({repetition.pattern}))", code):
        depth = 1
        for brace in braces.finditer(code, block.end(1)):
            depth += 1 if brace[0] == "{" else -1
            if depth == 0:
                body = code[block.end(1) : brace.start()]
                name = block["function"]
                if sleep_call.search(body) and (name is None or re.search(rf"\b{name}\s*\(", body)):
                    return True
                break
    return False


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("// Wait for the lock.\nsleep(delay).await;", False),
        ('let label = "for a lock"; sleep(delay).await;', False),
        ("for item in items { store(item); } sleep(delay).await;", False),
        ('let quote = \'"\'; loop { sleep(delay).await; let message = "retry"; }', True),
        ("stream.for_each(|_| async { sleep(delay).await; }).await;", True),
        ("async fn tick() { sleep(delay).await; Box::pin(tick()).await; }", True),
        ("async fn read() { sleep(delay).await; } async fn tick() { tick().await; }", False),
        ("loop { tokio::time::sleep(delay).await; }", True),
        ("while ready() { if retry { sleep_until(deadline).await; } }", True),
        ("for item in items { /* pause */ sleep(delay).await; }", True),
    ],
)
def test_schedule_contract_rejects_only_a_sleep_inside_a_loop(source: str, expected: bool) -> None:
    assert has_sleep_loop(source) == expected


def test_schedule_service_has_no_background_worker_or_retry_interval() -> None:
    service = Path(__file__).resolve().parents[2]
    source = service / "src"
    gear = (source / "gear.rs").read_text()
    config = (source / "config.rs").read_text()
    assert "drift" not in gear
    assert "drift" not in config
    schedules = source / "domain/connector_schedules"
    task = re.compile(r"\b(?:spawn(?:_blocking|_local|_on)?|spawn_bg)(?:\s*\(|\s+as\s+)")
    for path in schedules.rglob("*.rs"):
        relative = path.relative_to(schedules)
        assert "drift" not in path.stem, relative
        body = path.read_text()
        if path == schedules / "mod.rs":
            body = re.sub(
                r"tokio::spawn\(\s*async move \{ save_locked\(&state, &instance, revision, change, caller\)"
                r"\.await \}\s*\.in_current_span\(\),\s*\)\s*\.await\?",
                "",
                body,
            )
        if path == schedules / "timing.rs":
            body = body.replace("tokio::task::spawn_blocking(move || reconcile_times(&object, Utc::now())).await", "")
        assert not task.search(body), relative
        assert not re.search(r"\binterval(?:_at)?(?:\s*\(|\s+as\s+)", body), relative
        assert "retry_interval" not in body, relative
        assert not has_sleep_loop(body), relative

    for path in source.rglob("*.rs"):
        relative = path.relative_to(source)
        if path.is_relative_to(schedules) or any(part.endswith("tests") for part in relative.with_suffix("").parts):
            continue
        body = path.read_text()
        if path == source / "gear.rs":
            body = body.replace("tokio::spawn(crate::domain::run_history::observer::run(state, cancel));", "")
        if re.search(r"\bconnector_schedules\b", body):
            assert not task.search(body), relative


def test_compose_mounts_the_authentication_ca_bundle_for_connectors() -> None:
    root = Path(__file__).resolve().parents[6]
    compose = yaml.safe_load((root / "docker-compose.yml").read_text())
    assert "./deploy/compose/authn-tls-certs:/certs:ro" in compose["services"]["connectors"]["volumes"]
