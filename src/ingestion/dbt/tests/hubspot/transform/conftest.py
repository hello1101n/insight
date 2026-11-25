"""Runs actual HubSpot dbt models against an explicitly configured disposable warehouse.

Bronze comes from the HubSpot connector's own catalogue through
destination-clickhouse (`tests/bronze.py`), the one creator a deployment has, so
the tables a test writes into are the tables a sync would have made.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Iterator, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import clickhouse_connect
import pytest
import yaml
from clickhouse_connect.driver.client import Client
from dbt.cli.main import dbtRunner

INGESTION = Path(__file__).resolve().parents[4]
DBT = INGESTION / "dbt"
sys.path.insert(0, str(DBT / "tests"))
sys.path.insert(0, str(INGESTION / "scripts"))

from bronze import create_bronze  # noqa: E402
from dbt_profiles import Connection, build_profile  # noqa: E402

SOURCE = "synthetic-hubspot"
TENANT = "synthetic-tenant"
OTHER_TENANT = "synthetic-other-tenant"

# INVARIANT: every class_support_* union also reads the Zendesk arm, which reads
# Zendesk bronze; an empty one is enough.
CONNECTORS = ("hubspot", "zendesk")
BRONZE_DATABASES = ("bronze_hubspot", "bronze_zendesk")


def at(value: str) -> datetime:
    return datetime.fromisoformat(value).replace(tzinfo=UTC)


class Warehouse:
    def __init__(self, client: Client, profile: Path) -> None:
        self.client = client
        self.profile = profile
        self.tables = {
            f"{row[0]}.{row[1]}"
            for row in client.query(
                "SELECT database, name FROM system.tables WHERE database IN {databases:Array(String)}",
                parameters={"databases": list(BRONZE_DATABASES)},
            ).result_rows
        }

    def build(self, selector: str) -> None:
        messages: list[str] = []
        result = dbtRunner(callbacks=[lambda e: messages.append(e.info.msg)]).invoke(
            ["run", "--project-dir", str(DBT), "--profiles-dir", str(self.profile), "--quiet", "--select", selector]
        )
        assert result.success, "\n".join(messages)[-10000:]

    def failing_tests(self, names: Sequence[str]) -> set[str]:
        result = dbtRunner().invoke(
            ["test", "--project-dir", str(DBT), "--profiles-dir", str(self.profile), "--quiet", "--select", *names]
        )
        assert result.result is not None, f"dbt test did not run: {result.exception}"
        ran = {outcome.node.name for outcome in result.result.results if outcome.node.resource_type == "test"}
        assert set(names) <= ran, f"no such dbt tests: {sorted(set(names) - ran)}"
        return {
            outcome.node.name
            for outcome in result.result.results
            if outcome.node.resource_type == "test" and outcome.status in {"fail", "error"}
        }

    def insert(self, table: str, tenant: str | None, key: str, row: Mapping[str, object], extracted: str) -> None:
        """One HubSpot bronze record, keyed the way the connector keys it."""
        qualified = "bronze_hubspot." + table
        assert qualified in self.tables, f"no bronze table {qualified}"
        values = {
            "_airbyte_raw_id": str(uuid4()),
            "_airbyte_extracted_at": at(extracted),
            "_airbyte_meta": "{}",
            "_airbyte_generation_id": 0,
            "insight_tenant_id": tenant,
            "source_id": SOURCE,
            "unique_key": f"{tenant or 'no-tenant'}-{SOURCE}-{key}",
            "data_source": "hubspot",
            **row,
        }
        self.client.insert(qualified, [list(values.values())], column_names=list(values))

    def rows(self, sql: str) -> list[dict[str, object]]:
        return list(self.client.query(sql).named_results())


@pytest.fixture(scope="session")
def warehouse(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Warehouse]:
    if os.environ["HUBSPOT_TEST_DISPOSABLE"] != "yes":
        raise RuntimeError("Use only a disposable ClickHouse: this suite resets its HubSpot and Zendesk tables")
    connection = Connection(
        host=os.environ["CLICKHOUSE_HOST"],
        port=int(os.environ["CLICKHOUSE_HTTP_PORT"]),
        user=os.environ["CLICKHOUSE_USER"],
        password=os.environ["CLICKHOUSE_PASSWORD"],
        schema="default",
    )
    profile = tmp_path_factory.mktemp("profile")
    (profile / "profiles.yml").write_text(
        yaml.safe_dump(build_profile("test", connection, correlated_subqueries=False, threads=2))
    )
    client = clickhouse_connect.get_client(
        host=connection.host, port=connection.port, username=connection.user, password=connection.password
    )
    for connector in CONNECTORS:
        create_bronze(
            connector,
            port=os.environ["CLICKHOUSE_HTTP_PORT"],
            user=connection.user,
            password=connection.password,
            database="default",
        )
    for database in ("staging", "silver", "identity", "config"):
        client.command(f"CREATE DATABASE IF NOT EXISTS {database}")
    yield Warehouse(client, profile)
    client.close()


@pytest.fixture
def case(warehouse: Warehouse) -> Warehouse:
    for table in sorted(warehouse.tables):
        warehouse.client.command(f"TRUNCATE TABLE {table}")
    # INVARIANT: the HubSpot staging models are incremental, one of them never
    # fully refreshed, so a table left from the last case would carry its rows.
    for (name,) in warehouse.client.query(
        "SELECT name FROM system.tables WHERE database = 'staging' AND startsWith(name, 'hubspot__')"
    ).result_rows:
        warehouse.client.command(f"DROP TABLE staging.{name}")
    return warehouse
