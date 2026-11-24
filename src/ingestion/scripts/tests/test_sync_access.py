from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]


def test_sync_access_is_idempotent_and_only_syncs_are_memory_limited() -> None:
    url = os.environ.get("SYNC_TEST_CLICKHOUSE_URL")
    if not url:
        pytest.skip("Set SYNC_TEST_CLICKHOUSE_URL to a disposable ClickHouse server.")

    admin = os.environ["SYNC_TEST_CLICKHOUSE_USER"]
    admin_password = os.environ["SYNC_TEST_CLICKHOUSE_PASSWORD"]
    suffix = uuid4().hex
    user, database, bronze = f"sync_{suffix}", f"gold_{suffix}", f"bronze_{suffix}"
    password = "fixture';\\password"
    sync_settings = {
        "max_memory_usage_for_user": "25165824",
        "max_memory_usage": "8388608",
        "max_bytes_before_external_group_by": "4194304",
        "max_bytes_before_external_sort": "4194304",
        "max_bytes_ratio_before_external_group_by": "0",
        "max_bytes_ratio_before_external_sort": "0",
        "memory_usage_overcommit_max_wait_microseconds": "0",
    }

    def execute(query: str, *, sync: bool = False) -> str:
        headers = {
            "X-ClickHouse-User": user if sync else admin,
            "X-ClickHouse-Key": password if sync else admin_password,
        }
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with urlopen(Request(url, data=query.encode(), headers=headers), timeout=15) as response:
            return response.read().decode().strip()

    env = os.environ | {
        "CLICKHOUSE_URL": url,
        "CLICKHOUSE_USER": admin,
        "CLICKHOUSE_PASSWORD": admin_password,
        "CLICKHOUSE_DATABASE": database,
        "CLICKHOUSE_PROVISION_ACCESS": "true",
        "CLICKHOUSE_SYNC_USER": user,
        "CLICKHOUSE_SYNC_PASSWORD": password,
        "CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES": sync_settings["max_memory_usage_for_user"],
        "CLICKHOUSE_SYNC_QUERY_MEMORY_BYTES": sync_settings["max_memory_usage"],
    }

    def bootstrap() -> None:
        result = subprocess.run(
            ["bash", str(SCRIPTS / "create-databases.sh")], env=env, capture_output=True, text=True, timeout=30
        )
        assert result.returncode == 0, result.stderr

    def account() -> tuple[str, str, str]:
        return (
            execute(f"SELECT id FROM system.users WHERE name = '{user}'"),
            execute(f"SHOW CREATE USER {user}"),
            execute(f"SHOW GRANTS FOR {user}"),
        )

    query = "SELECT length(groupArray(number)) FROM numbers(8000000)"
    try:
        bootstrap()
        exists = execute(f"SELECT count() FROM system.users WHERE name = '{user}'")
        assert exists == "1", "The database bootstrap must create the sync user."
        first = account()
        bootstrap()
        assert account() == first

        names = ", ".join(f"'{name}'" for name in sync_settings)
        rows = execute(f"SELECT name, value FROM system.settings WHERE name IN ({names}) FORMAT JSONEachRow", sync=True)
        settings = dict((record["name"], record["value"]) for record in map(json.loads, rows.splitlines()))
        assert settings == sync_settings
        assert (
            execute("SELECT getSetting('max_memory_usage') SETTINGS max_memory_usage=67108864", sync=True) == "67108864"
        )
        with pytest.raises(HTTPError) as override:
            execute("SELECT 1 SETTINGS max_memory_usage_for_user=0", sync=True)
        assert "SETTING_CONSTRAINT_VIOLATION" in override.value.read().decode()

        execute(f"CREATE DATABASE {bronze}", sync=True)
        execute(f"CREATE TABLE {bronze}.test (id UInt64) ENGINE=MergeTree ORDER BY id", sync=True)
        execute(f"INSERT INTO {bronze}.test VALUES (1)", sync=True)
        execute(f"CREATE TABLE {database}.stage AS {bronze}.test", sync=True)
        execute(f"CREATE TABLE {database}.published AS {bronze}.test", sync=True)
        execute(f"EXCHANGE TABLES {database}.stage AND {database}.published", sync=True)
        with pytest.raises(HTTPError) as unrelated:
            execute("CREATE TABLE presentation.sync_test (id UInt64) ENGINE=Memory", sync=True)
        assert "ACCESS_DENIED" in unrelated.value.read().decode()

        with pytest.raises(HTTPError) as over_budget:
            execute(query + " SETTINGS max_memory_usage=134217728, max_threads=1", sync=True)
        error = over_budget.value.read().decode()
        assert "Code: 241" in error
        assert "User memory limit" in error or "(for user)" in error
        assert execute(query + " SETTINGS max_threads=1") == "8000000"
        query_keys = sync_settings.keys() - {
            "max_memory_usage_for_user",
            "memory_usage_overcommit_max_wait_microseconds",
        }
        names = ", ".join(f"'{name}'" for name in sorted(query_keys))
        settings_sql = f"SELECT name, value FROM system.settings WHERE name IN ({names}) ORDER BY name"
        del env["CLICKHOUSE_SYNC_QUERY_MEMORY_BYTES"]
        bootstrap()
        assert execute(settings_sql, sync=True) == execute(settings_sql)

        del env["CLICKHOUSE_SYNC_TOTAL_MEMORY_BYTES"]
        bootstrap()
        server = int(execute("SELECT value FROM system.server_settings WHERE name = 'max_server_memory_usage'"))
        assert execute("SELECT getSetting('max_memory_usage_for_user')", sync=True) == str(server * 3 // 5)
    finally:
        execute(f"DROP USER IF EXISTS {user}")
        execute(f"DROP DATABASE IF EXISTS {bronze}")
        execute(f"DROP DATABASE IF EXISTS {database}")


def test_a_missing_sync_password_stops_provisioning() -> None:
    env = {
        "PATH": os.environ["PATH"],
        "CLICKHOUSE_URL": "http://127.0.0.1:9",
        "CLICKHOUSE_USER": "admin",
        "CLICKHOUSE_PASSWORD": "admin-fixture",
        "CLICKHOUSE_SYNC_USER": "sync_fixture",
        "CLICKHOUSE_SYNC_PASSWORD": "",
    }
    result = subprocess.run(
        ["bash", str(SCRIPTS / "bootstrap-db/provision-sync-access.sh")],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 1
    assert "The ClickHouse sync password is missing from its Secret." in result.stderr


def test_cluster_mode_takes_the_smallest_limit_of_the_replicas_that_answer(tmp_path: Path) -> None:
    bodies = tmp_path / "bodies"
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    curl = bin_dir / "curl"
    curl.write_text(f"#!/bin/bash\ncat >> '{bodies}'\nprintf '\\n;\\n' >> '{bodies}'\nprintf '10000000001'\n")
    curl.chmod(0o755)
    env = {
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "CLICKHOUSE_URL": "http://clickhouse.invalid:8123",
        "CLICKHOUSE_USER": "admin",
        "CLICKHOUSE_PASSWORD": "admin-fixture",
        "CLICKHOUSE_DATABASE": "insight",
        "CLICKHOUSE_CLUSTER_MODE": "true",
        "CLICKHOUSE_CLUSTER_NAME": "insight_cluster",
        "CLICKHOUSE_SYNC_USER": "sync_fixture",
        "CLICKHOUSE_SYNC_PASSWORD": "sync-fixture",
    }
    result = subprocess.run(
        ["bash", str(SCRIPTS / "bootstrap-db/provision-sync-access.sh")],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    statements = bodies.read_text().split("\n;\n")
    assert statements[0] == (
        "SELECT min(toUInt64(value)) FROM clusterAllReplicas('insight_cluster', system.server_settings) "
        "WHERE name = 'max_server_memory_usage' SETTINGS skip_unavailable_shards = 1"
    )
    assert "max_memory_usage_for_user = 6000000000 CONST" in statements[1]
