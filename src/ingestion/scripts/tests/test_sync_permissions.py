from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from uuid import uuid4

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
DBT = SCRIPTS.parent / "dbt"
ROOT = SCRIPTS.parents[2]
CONFIG_TABLES = (
    "task_field_roles",
    "task_value_map",
    "field_value_map",
    "field_value_defaults",
    "ai_seat_tier_map",
    "ai_credit_pricing",
)
TENANT = "00000000-0000-0000-0000-000000000001"


def run(command: list[str], env: dict[str, str], *, data: str | None = None) -> str:
    result = subprocess.run(command, input=data, env=env, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout[-6000:] + result.stderr[-3000:]
    return result.stdout


def airbyte_write(directory: Path, env: dict[str, str], url: str, user: str, password: str) -> None:
    hubspot = {
        "unique_key": "example-owner",
        "insight_tenant_id": TENANT,
        "insight_source_id": "example",
        "teams": '[{"id":"example","name":"Example"}]',
        "data_source": "hubspot",
        "updatedAt": "2026-01-01T00:00:00Z",
    }
    jira = {"unique_key": "example-change", "id_readable": "EXAMPLE-1", "created": "2026-01-01", "items": "[]"}
    streams = []
    messages = []
    for namespace, name, record, timestamps in [
        ("bronze_hubspot", "owners", hubspot, ("updatedAt", "archivedAt")),
        ("bronze_jira", "jira_issue_history", jira, ()),
    ]:
        properties = {key: {"type": "string"} for key in record}
        for key in timestamps:
            properties[key] = {"type": "string", "format": "date-time"}
        streams.append(
            {
                "stream": {
                    "name": name,
                    "namespace": namespace,
                    "supported_sync_modes": ["full_refresh"],
                    "json_schema": {"type": "object", "properties": properties},
                },
                "sync_mode": "full_refresh",
                "destination_sync_mode": "append_dedup",
                "primary_key": [["unique_key"]],
                "generation_id": 1,
                "minimum_generation_id": 0,
                "sync_id": 1,
            }
        )
        messages.extend(
            [
                {"type": "RECORD", "record": {"stream": name, "namespace": namespace, "data": record, "emitted_at": 1}},
                {
                    "type": "TRACE",
                    "trace": {
                        "type": "STREAM_STATUS",
                        "emitted_at": 2,
                        "stream_status": {
                            "stream_descriptor": {"name": name, "namespace": namespace},
                            "status": "COMPLETE",
                        },
                    },
                },
            ]
        )
    host = os.environ["SYNC_TEST_CLICKHOUSE_CONTAINER_HOST"]
    (directory / "destination.json").write_text(
        json.dumps(
            {
                "host": host,
                "port": str(urlsplit(url).port),
                "protocol": "http",
                "database": "insight",
                "username": user,
                "password": password,
                "enable_json": False,
            }
        )
    )
    (directory / "catalog.json").write_text(json.dumps({"streams": streams}))
    directory.chmod(0o755)
    for path in directory.glob("*.json"):
        path.chmod(0o644)
    pins = (SCRIPTS / "bootstrap-db/pins.env").read_text().splitlines()
    image = next(line.partition("=")[2] for line in pins if line.startswith("DESTINATION_CLICKHOUSE_IMAGE="))
    output = run(
        [
            "docker",
            "run",
            "--rm",
            "-i",
            "-v",
            f"{directory}:/work:ro",
            image,
            "write",
            "--config",
            "/work/destination.json",
            "--catalog",
            "/work/catalog.json",
        ],
        env,
        data="\n".join(map(json.dumps, messages)) + "\n",
    )
    assert "Destination write complete" in output


@pytest.mark.parametrize("provisioning", ["chart", "operator"])
def test_sync_account_runs_the_warehouse_paths(tmp_path: Path, provisioning: str) -> None:
    url = os.environ.get("SYNC_TEST_CLICKHOUSE_URL")
    if not url or not os.environ.get("SYNC_TEST_CLICKHOUSE_CONTAINER_HOST"):
        pytest.skip("Set the disposable ClickHouse URL and its host as seen by Docker.")
    admin, admin_password = os.environ["SYNC_TEST_CLICKHOUSE_USER"], os.environ["SYNC_TEST_CLICKHOUSE_PASSWORD"]
    user, password = f"sync_{uuid4().hex}", "example-sync-password"

    def sql(statement: str, *, sync: bool = False) -> str:
        headers = {
            "X-ClickHouse-User": user if sync else admin,
            "X-ClickHouse-Key": password if sync else admin_password,
        }
        request = Request(url, data=statement.encode(), headers=headers)
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with urlopen(request, timeout=20) as response:
            return response.read().decode().strip()

    env = os.environ | {
        "CLICKHOUSE_URL": url,
        "CLICKHOUSE_USER": admin,
        "CLICKHOUSE_PASSWORD": admin_password,
        "CLICKHOUSE_DATABASE": "insight",
        "CLICKHOUSE_SYNC_USER": user,
        "CLICKHOUSE_SYNC_PASSWORD": password,
        "CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES": str(512 * 1024 * 1024),
        "CLICKHOUSE_SYNC_QUERY_MEMORY_BYTES": str(256 * 1024 * 1024),
        "DBT_LOG_PATH": str(tmp_path / "logs"),
        "DBT_TARGET_PATH": str(tmp_path / "target"),
    }
    schemas = ("staging", "silver", "insight", "identity", "config")
    isolated = ("bronze_hubspot", "bronze_jira", "dbt_test__audit")
    owned = [
        *(f"config.{name}" for name in CONFIG_TABLES),
        "identity.identity_persons",
        "identity.identity_inputs",
        "identity.identity_persons_staging_fixture",
        "staging.hubspot__crm_teams",
        "silver.class_crm_teams",
        "insight.bronze_insert_events",
    ]
    for name in isolated:
        assert sql(f"EXISTS DATABASE {name}") == "0", f"Fixture database already exists: {name}"
    for name in owned:
        assert sql(f"EXISTS TABLE {name}") == "0", f"Fixture relation already exists: {name}"

    try:
        for name in schemas:
            sql(f"CREATE DATABASE IF NOT EXISTS {name}")
        if provisioning == "chart":
            run(["bash", str(SCRIPTS / "bootstrap-db/provision-sync-access.sh")], env)
        else:
            readme = (ROOT / "charts/insight/README.md").read_text()
            instructions = readme.split("### Provision the sync user on an operator-managed ClickHouse server", 1)[1]
            ddl = instructions.split("```sql", 1)[1].split("```", 1)[0]
            for statement in ddl.replace("insight_sync", user).replace("example-password", password).split(";"):
                if statement.strip():
                    sql(statement)
        airbyte_write(tmp_path, env, url, user, password)
        sync_env = env | {"CLICKHOUSE_USER": user, "CLICKHOUSE_PASSWORD": password}
        run([sys.executable, str(SCRIPTS / "dbt_profiles.py"), "--profiles-dir", str(tmp_path)], sync_env)
        dbt = [str(Path(sys.executable).with_name("dbt"))]
        options = ["--project-dir", str(DBT), "--profiles-dir", str(tmp_path)]
        run(
            [*dbt, "run", *options, "--select", "hubspot__crm_teams", "class_crm_teams", "bronze_insert_events"],
            sync_env,
        )
        run([*dbt, "test", *options, "--select", "assert_changelog_items_not_double_encoded"], sync_env)
        assert sql("SELECT name FROM silver.class_crm_teams FINAL", sync=True) == "Example"
        assert sql("SELECT count() FROM insight.bronze_insert_events", sync=True) == "2"
        assert sql("SELECT count() FROM dbt_test__audit.assert_changelog_items_not_double_encoded", sync=True) == "0"

        sql(
            f"CREATE VIEW identity.identity_inputs AS SELECT toUUID('{TENANT}') AS insight_tenant_id, "
            "'example' AS insight_source_type, "
            "toUUID('00000000-0000-0000-0000-000000000001') AS insight_source_id, "
            "'example' AS source_account_id, 'email' AS value_type, 'user@example.com' AS value, "
            "now64(3) AS _synced_at, 'UPSERT' AS operation_type",
            sync=True,
        )
        reader = ROOT / "src/backend/services/identity-resolution/src/infra/identity_inputs.rs"
        query = re.search(r'const STREAM_SQL: &str = r"(.*?)";', reader.read_text(), flags=re.S)
        assert query is not None
        assert "user@example.com" in sql(query[1].replace("?", f"'{TENANT}'"), sync=True)
        sql("SELECT if(count() = 0, NULL, max(id)) FROM identity.identity_persons", sync=True)
        sql("SELECT toUnixTimestamp64Milli(max(_synced_at)) FROM identity.identity_persons", sync=True)
        staging = "identity.identity_persons_staging_fixture"
        sql(f"CREATE TABLE {staging} AS identity.identity_persons", sync=True)
        sql(f"INSERT INTO {staging} (id) VALUES (1)", sync=True)
        assert sql(f"SELECT count() FROM {staging}", sync=True) == "1"
        sql(f"EXCHANGE TABLES {staging} AND identity.identity_persons", sync=True)
        sql(f"DROP TABLE {staging}", sync=True)
        assert sql("SELECT max(id) FROM identity.identity_persons", sync=True) == "1"

        with pytest.raises(HTTPError) as denied:
            sql("TRUNCATE TABLE config.task_value_map", sync=True)
        assert "ACCESS_DENIED" in denied.value.read().decode()
    finally:
        for name in reversed(owned):
            sql(f"DROP TABLE IF EXISTS {name}")
        for name in isolated:
            sql(f"DROP DATABASE IF EXISTS {name}")
        sql(f"DROP USER IF EXISTS {user}")
