"""Prepare a disposable warehouse for the env-driven transform suites (bamboohr, chatgpt_team, active_directory).

Those suites read CLICKHOUSE_HOST/PORT/USER/PASSWORD, DBT_EXECUTABLE and DBT_PROFILES_DIR. With
TRANSFORM_TEST_DISPOSABLE=yes (the CI lane) this creates the connectors' bronze through the destination,
the databases dbt writes into, and a profile, and exports DBT_PROFILES_DIR. Without it nothing is
created and the suite runs against the warehouse the caller already prepared.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import clickhouse_connect
import yaml

INGESTION = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(INGESTION / "scripts"))

from bronze import create_bronze  # noqa: E402
from dbt_profiles import Connection, build_profile  # noqa: E402


def prepare(connectors: tuple[str, ...], profile_dir: Path) -> None:
    if os.environ.get("TRANSFORM_TEST_DISPOSABLE") != "yes":
        return
    connection = Connection(
        host=os.environ["CLICKHOUSE_HOST"],
        port=int(os.environ["CLICKHOUSE_PORT"]),
        user=os.environ["CLICKHOUSE_USER"],
        password=os.environ["CLICKHOUSE_PASSWORD"],
    )
    for connector in connectors:
        create_bronze(
            connector, port=connection.port, user=connection.user, password=connection.password, database="default"
        )
    client = clickhouse_connect.get_client(
        host=connection.host, port=connection.port, username=connection.user, password=connection.password
    )
    for database in ("staging", "silver", "identity", "config", "insight"):
        client.command(f"CREATE DATABASE IF NOT EXISTS {database}")
    client.close()
    (profile_dir / "profiles.yml").write_text(
        yaml.safe_dump(build_profile("local", connection, correlated_subqueries=True))
    )
    os.environ["DBT_PROFILES_DIR"] = str(profile_dir)
