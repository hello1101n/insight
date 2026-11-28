from __future__ import annotations

import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import clickhouse_connect
import pytest
from clickhouse_connect.driver.client import Client

DBT_DIR = Path(__file__).resolve().parents[2]


@pytest.fixture
def warehouse() -> Client:
    return clickhouse_connect.get_client(
        host=os.environ["CLICKHOUSE_HOST"],
        port=int(os.environ["CLICKHOUSE_PORT"]),
        username=os.environ["CLICKHOUSE_USER"],
        password=os.environ["CLICKHOUSE_PASSWORD"],
    )


def snapshot(warehouse: Client, tenant: str | None, source: str, entries: list[object], second: int) -> None:
    # Bronze is a ReplacingMergeTree on unique_key: a shared (empty) key would let a background
    # merge collapse every test's snapshots into one, so each read gets its own.
    raw_id = str(uuid4())
    warehouse.insert(
        "bronze_bamboohr.whos_out",
        [
            [
                raw_id,
                raw_id,
                datetime(2025, 6, 1, 0, 0, second, tzinfo=UTC),
                tenant,
                source,
                json.dumps(entries),
                "2025-05-01",
                "2025-05-31",
            ]
        ],
        column_names=[
            "_airbyte_raw_id",
            "unique_key",
            "_airbyte_extracted_at",
            "insight_tenant_id",
            "insight_source_id",
            "entries_json",
            "window_start",
            "window_end",
        ],
    )


def build() -> None:
    subprocess.run(
        [
            os.environ["DBT_EXECUTABLE"],
            "build",
            "--profiles-dir",
            os.environ["DBT_PROFILES_DIR"],
            "--select",
            "bamboohr__person_absences",
            "class_person_absences",
        ],
        cwd=DBT_DIR,
        check=True,
        capture_output=True,
        text=True,
    )


def intervals(warehouse: Client, tenant: str, source: str) -> list[tuple[str, str, str]]:
    return warehouse.query(
        "SELECT account_id, toString(start_date), toString(end_date) "
        "FROM silver.class_person_absences FINAL "
        "WHERE insight_tenant_id = {tenant:String} "
        "AND account_source_id = {source:String} ORDER BY account_id",
        parameters={"tenant": tenant, "source": source},
    ).result_rows


def test_latest_snapshot_replaces_intervals_without_clearing_other_sources(warehouse: Client) -> None:
    tenant = str(uuid4())
    other_tenant = str(uuid4())
    source = str(uuid4())
    other_source = str(uuid4())
    leave = {"type": "timeOff", "employeeId": 7, "start": "2025-04-28", "end": "2025-05-02"}
    snapshot(warehouse, tenant, source, [leave], 1)
    snapshot(warehouse, tenant, other_source, [leave], 1)
    snapshot(warehouse, other_tenant, source, [leave], 1)
    build()
    expected = [("7", "2025-05-01", "2025-05-02")]
    assert intervals(warehouse, tenant, source) == expected

    snapshot(warehouse, tenant, source, [], 3)
    snapshot(warehouse, tenant, source, [leave], 2)
    build()
    assert intervals(warehouse, tenant, source) == []
    assert intervals(warehouse, tenant, other_source) == expected
    assert intervals(warehouse, other_tenant, source) == expected

    build()
    assert intervals(warehouse, tenant, other_source) == expected


def test_only_valid_person_intervals_within_snapshot_window_are_promoted(warehouse: Client) -> None:
    tenant = str(uuid4())
    source = str(uuid4())
    leave = {"type": "timeOff", "employeeId": "employee-example", "start": "2025-05-31", "end": "2025-06-02"}
    entries: list[object] = [
        leave,
        leave,
        {**leave, "type": "holiday"},
        {**leave, "employeeId": ""},
        {**leave, "employeeId": None},
        {**leave, "employeeId": True},
        {**leave, "employeeId": {"id": 7}},
        {**leave, "start": "not-a-date"},
        {**leave, "end": None},
        {**leave, "start": "2025-05-20", "end": "2025-05-19"},
        {**leave, "start": "2025-06-01"},
        None,
        42,
        "invalid",
    ]
    snapshot(warehouse, tenant, source, entries, 1)
    build()
    assert intervals(warehouse, tenant, source) == [("employee-example", "2025-05-31", "2025-05-31")]


@pytest.mark.parametrize("tenant", [None, "", "not-a-uuid"])
def test_a_snapshot_without_a_valid_tenant_fails_the_build(warehouse: Client, tenant: str | None) -> None:
    """Such a snapshot used to be filtered out silently; bronze_tenant() now names it."""
    source = str(uuid4())
    snapshot(
        warehouse, tenant, source, [{"type": "timeOff", "employeeId": 7, "start": "2025-05-01", "end": "2025-05-02"}], 1
    )
    try:
        with pytest.raises(subprocess.CalledProcessError) as failure:
            build()
        assert (
            "bamboohr__person_absences: a Bronze insight_tenant_id is NULL, empty or not a UUID" in failure.value.stdout
        )
    finally:
        warehouse.command(
            "ALTER TABLE bronze_bamboohr.whos_out DELETE WHERE insight_source_id = {source:String} SETTINGS mutations_sync = 2",
            parameters={"source": source},
        )


@pytest.mark.parametrize("tenant", [None, "not-a-uuid"])
def test_attribute_claims_fail_on_an_employee_without_a_valid_tenant(warehouse: Client, tenant: str | None) -> None:
    """attribute_claims joins its watermark on the tenant; the row must fail the build, not drop out."""
    source = str(uuid4())
    warehouse.insert(
        "bronze_bamboohr.employees",
        [[str(uuid4()), datetime(2025, 6, 1, tzinfo=UTC), tenant, source, f"{source}-7", "7", "Engineer", "{}"]],
        column_names=[
            "_airbyte_raw_id",
            "_airbyte_extracted_at",
            "insight_tenant_id",
            "insight_source_id",
            "unique_key",
            "id",
            "jobTitle",
            "raw_data",
        ],
    )
    try:
        result = subprocess.run(
            [
                os.environ["DBT_EXECUTABLE"],
                "run",
                "--profiles-dir",
                os.environ["DBT_PROFILES_DIR"],
                "--select",
                "+bamboohr__person_attribute_claims",
            ],
            cwd=DBT_DIR,
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert (
            "bamboohr__person_attribute_claims: a Bronze insight_tenant_id is NULL, empty or not a UUID"
            in result.stdout
        )
    finally:
        warehouse.command(
            "ALTER TABLE bronze_bamboohr.employees DELETE WHERE insight_source_id = {source:String} SETTINGS mutations_sync = 2",
            parameters={"source": source},
        )
        warehouse.command(
            "ALTER TABLE staging.bamboohr__employees_snapshot DELETE WHERE insight_source_id = {source:String}"
            " SETTINGS mutations_sync = 2",
            parameters={"source": source},
        )
