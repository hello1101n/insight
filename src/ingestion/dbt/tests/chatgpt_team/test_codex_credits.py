"""ChatGPT Team Codex models over real dbt and ClickHouse: credit watermark, reconciliation keys, tenant guard.

Run like ../bamboohr/test_person_absences.py: bronze_chatgpt_team created by the connector,
CLICKHOUSE_HOST/PORT/USER/PASSWORD, DBT_EXECUTABLE and DBT_PROFILES_DIR set.
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
CREDITS = "staging.chatgpt_team__ai_credit_usage"


@pytest.fixture
def warehouse() -> Client:
    return clickhouse_connect.get_client(
        host=os.environ["CLICKHOUSE_HOST"],
        port=int(os.environ["CLICKHOUSE_PORT"]),
        username=os.environ["CLICKHOUSE_USER"],
        password=os.environ["CLICKHOUSE_PASSWORD"],
    )


def leaderboard(warehouse: Client, tenant: str | None, source: str, user: str, day: str, credits: int) -> None:
    warehouse.insert(
        "bronze_chatgpt_team.chatgpt_team_codex_user_daily",
        [
            [
                str(uuid4()),
                datetime(2026, 3, 20, tzinfo=UTC),
                tenant,
                source,
                f"{source}-{user}-{day}",
                day,
                f"{user}@example.com",
                user,
                credits,
            ]
        ],
        column_names=[
            "_airbyte_raw_id",
            "_airbyte_extracted_at",
            "insight_tenant_id",
            "source_id",
            "unique_key",
            "date",
            "email",
            "user_id",
            "credits",
        ],
    )


def sessions(warehouse: Client, tenant: str, source: str, user: str, day: str, credits: int) -> None:
    warehouse.insert(
        "bronze_chatgpt_team.chatgpt_team_codex_sessions_daily",
        [
            [
                str(uuid4()),
                datetime(2026, 3, 20, tzinfo=UTC),
                tenant,
                source,
                f"{source}-{user}-{day}",
                day,
                user,
                credits,
            ]
        ],
        column_names=[
            "_airbyte_raw_id",
            "_airbyte_extracted_at",
            "insight_tenant_id",
            "source_id",
            "unique_key",
            "date",
            "user_id",
            "credit_total",
        ],
    )


def dbt(*select: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [os.environ["DBT_EXECUTABLE"], "run", "--profiles-dir", os.environ["DBT_PROFILES_DIR"], "--select", *select],
        cwd=DBT_DIR,
        capture_output=True,
        text=True,
    )


def build(*select: str) -> None:
    result = dbt(*select)
    assert result.returncode == 0, result.stdout


def days(warehouse: Client, tenant: str, source: str) -> list[str]:
    return [
        row[0]
        for row in warehouse.query(
            f"SELECT toString(day) FROM {CREDITS} FINAL "
            "WHERE insight_tenant_id = {tenant:String} AND source_id = {source:String} ORDER BY day",
            parameters={"tenant": tenant, "source": source},
        ).result_rows
    ]


def test_an_instance_the_table_has_never_held_keeps_its_rows(warehouse: Client) -> None:
    """A first-seen instance must read everything, however old its days.

    The old per-instance LEFT JOIN gave an unmatched instance latest_day = 1970-01-01,
    and `- INTERVAL 3 DAY` wrapped that to 2149, so its rows were dropped on every run.
    """
    tenant = str(uuid4())
    known, new = str(uuid4()), str(uuid4())
    leaderboard(warehouse, tenant, known, "alice", "2026-03-10", 5)
    build("chatgpt_team__ai_credit_usage")
    assert days(warehouse, tenant, known) == ["2026-03-10"]

    leaderboard(warehouse, tenant, new, "bob", "2026-01-05", 7)
    build("chatgpt_team__ai_credit_usage")
    assert days(warehouse, tenant, new) == ["2026-01-05"]


def test_a_known_instance_keeps_its_own_floor(warehouse: Client) -> None:
    """The fix keeps the floor per instance: an old day another instance never raised is still read."""
    tenant = str(uuid4())
    busy, quiet = str(uuid4()), str(uuid4())
    leaderboard(warehouse, tenant, busy, "alice", "2026-03-10", 5)
    leaderboard(warehouse, tenant, quiet, "bob", "2026-02-01", 7)
    build("chatgpt_team__ai_credit_usage")

    leaderboard(warehouse, tenant, quiet, "bob", "2026-02-02", 8)
    build("chatgpt_team__ai_credit_usage")
    assert days(warehouse, tenant, quiet) == ["2026-02-01", "2026-02-02"]


def test_reconciliation_keeps_the_tenant_of_a_one_sided_row(warehouse: Client) -> None:
    """Both sides are non-Nullable, so coalesce() over the FULL JOIN kept '' for a sessions-only row.

    A leaderboard row with an unparsable date is dropped at the read: its NULL day would otherwise
    read as "no leaderboard row" and surface as a blank sessions_only row.
    """
    tenant, source = str(uuid4()), str(uuid4())
    alice, bob, carol, dave = (f"{name}-{source}" for name in ("alice", "bob", "carol", "dave"))
    leaderboard(warehouse, tenant, source, alice, "2026-03-10", 5)
    sessions(warehouse, tenant, source, bob, "2026-03-10", 3)
    leaderboard(warehouse, tenant, source, carol, "not-a-date", 4)
    sessions(warehouse, tenant, source, carol, "2026-03-10", 4)
    leaderboard(warehouse, tenant, source, dave, "not-a-date", 2)
    build("chatgpt_team__codex_reconciliation")
    rows = warehouse.query(
        "SELECT user_id, seen_in, insight_tenant_id, source_id FROM staging.chatgpt_team__codex_reconciliation "
        "WHERE user_id IN {users:Array(String)} ORDER BY user_id",
        parameters={"users": [alice, bob, carol, dave]},
    ).result_rows
    assert rows == [
        (alice, "leaderboard_only", tenant, source),
        (bob, "sessions_only", tenant, source),
        (carol, "sessions_only", tenant, source),
    ]


@pytest.mark.parametrize("tenant", [None, "", "not-a-uuid"])
@pytest.mark.parametrize(
    "model",
    [
        "chatgpt_team__ai_credit_usage",
        # Joins and the completeness gate compare the tenant; the row must fail, not fall out of a join.
        "chatgpt_team__ai_dev_usage",
    ],
)
def test_a_bronze_row_without_a_valid_tenant_fails_the_build(warehouse: Client, tenant: str | None, model: str) -> None:
    marker = str(uuid4())
    leaderboard(warehouse, tenant, marker, "eve", "2026-03-10", 1)
    try:
        result = dbt(model)
        assert result.returncode != 0
        assert f"{model}: a Bronze" in result.stdout
        assert "is NULL, empty or not a UUID" in result.stdout
    finally:
        warehouse.command(
            "ALTER TABLE bronze_chatgpt_team.chatgpt_team_codex_user_daily DELETE WHERE source_id = {marker:String}"
            " SETTINGS mutations_sync = 2",
            parameters={"marker": marker},
        )
