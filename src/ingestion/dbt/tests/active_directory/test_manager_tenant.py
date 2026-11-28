"""active_directory__manager_identity_inputs joins history to Bronze users on the tenant.

A Bronze user without a valid tenant must fail the build, not fall out of that join. Run like
../bamboohr/test_person_absences.py.
"""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import clickhouse_connect
import pytest
from clickhouse_connect.driver.client import Client

DBT_DIR = Path(__file__).resolve().parents[2]
MODEL = "active_directory__manager_identity_inputs"


@pytest.fixture
def warehouse() -> Client:
    return clickhouse_connect.get_client(
        host=os.environ["CLICKHOUSE_HOST"],
        port=int(os.environ["CLICKHOUSE_PORT"]),
        username=os.environ["CLICKHOUSE_USER"],
        password=os.environ["CLICKHOUSE_PASSWORD"],
    )


def user(warehouse: Client, tenant: str | None, source: str, key: str, guid: str, dn: str, manager_dn: str) -> None:
    warehouse.insert(
        "bronze_active_directory.users",
        [
            [
                str(uuid4()),
                datetime(2026, 3, 1, tzinfo=UTC),
                tenant,
                source,
                key,
                guid,
                dn,
                manager_dn,
                f"{guid}@example.com",
            ]
        ],
        column_names=[
            "_airbyte_raw_id",
            "_airbyte_extracted_at",
            "insight_tenant_id",
            "insight_source_id",
            "unique_key",
            "id",
            "distinguishedName",
            "managerDn",
            "mail",
        ],
    )


def dbt(*select: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [os.environ["DBT_EXECUTABLE"], "run", "--profiles-dir", os.environ["DBT_PROFILES_DIR"], "--select", *select],
        cwd=DBT_DIR,
        capture_output=True,
        text=True,
    )


@pytest.mark.parametrize("tenant", [None, "not-a-uuid"])
def test_a_manager_without_a_valid_tenant_fails_the_build(warehouse: Client, tenant: str | None) -> None:
    valid, source = str(uuid4()), str(uuid4())
    user(warehouse, valid, source, f"{source}-mgr", "mgr", "CN=Mgr", "")
    user(warehouse, valid, source, f"{source}-rep", "rep", "CN=Rep", "CN=Mgr")
    try:
        built = dbt(f"+{MODEL}")
        assert built.returncode == 0, built.stdout
        # Only Bronze loses the tenant; the history the model joins it to stays valid.
        user(warehouse, tenant, source, f"{source}-mgr-copy", "mgr", "CN=Mgr", "")
        result = dbt(MODEL, "--full-refresh")
        assert result.returncode != 0, "a manager row without a tenant was silently dropped from the join"
        assert f"{MODEL}: a Bronze insight_tenant_id is NULL, empty or not a UUID" in result.stdout
    finally:
        for statement in (
            "ALTER TABLE bronze_active_directory.users DELETE WHERE insight_source_id = {source:String}",
            "ALTER TABLE staging.active_directory__users_snapshot DELETE WHERE insight_source_id = {source:String}",
            "ALTER TABLE staging.active_directory__users_fields_history DELETE WHERE insight_source_id = {source:String}",
        ):
            warehouse.command(statement + " SETTINGS mutations_sync = 2", parameters={"source": source})
