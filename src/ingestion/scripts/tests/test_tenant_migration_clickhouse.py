"""The tenant migration against a real ClickHouse: every key form, the skip rules,
and the way back when a run fails part-way.

Needs a throwaway server — it drops and recreates the databases it seeds:

    TENANT_MIGRATION_TEST_CH_URL=http://localhost:38211 \\
    TENANT_MIGRATION_TEST_CH_USER=insight TENANT_MIGRATION_TEST_CH_PASSWORD=insight \\
    uvx pytest tests/test_tenant_migration_clickhouse.py
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tenant_migration import apply as migration
from tenant_migration.__main__ import main
from tenant_migration.clickhouse import ClickHouse, ClickHouseError
from tenant_migration.inventory import InventoryError, discover, history_relations
from tenant_migration.plan import TablePlan, survey

NEW = "0f6b3c2e-5d4a-4e7b-9c1d-2a3b4c5d6e7f"
OLD = "example-main-legacy"
DATABASES = ("bronze_example", "bronze_bamboohr", "bronze_youtrack", "staging", "config", "ingestion_history")
RESET = [step for db in DATABASES for step in (f"DROP DATABASE IF EXISTS {db} SYNC", f"CREATE DATABASE {db}")]
TABLES = (
    "bronze_example.items",
    "bronze_example.colon_items",
    "bronze_bamboohr.whos_out",
    "bronze_youtrack.youtrack_comments",
    "staging.jira__catalogue_first_seen",
    "staging.slack__users_snapshot",
    "staging.youtrack__field_observations",
    "config.task_value_map",
    "ingestion_history.sync_events",
)

SCHEMA = f"""
CREATE TABLE bronze_example.items (unique_key String, tenant_id Nullable(String), source_id Nullable(String),
    payload String, _airbyte_extracted_at DateTime64(3))
ENGINE = ReplacingMergeTree(_airbyte_extracted_at) ORDER BY unique_key COMMENT 'synthetic items';
INSERT INTO bronze_example.items VALUES
    ('{OLD}-main-PROJ-7', '{OLD}', 'main', 'the old tenant, whose own key holds the source name', '2026-01-02 00:00:00'),
    ('-main-PROJ-7', NULL, 'main', 'the same entity written before the tenant was stamped', '2026-01-01 00:00:00'),
    ('-main-PROJ-8', '', 'main', 'an empty tenant', '2026-01-02 00:00:00'),
    ('{NEW}-main-PROJ-9', '{NEW}', 'main', 'already canonical', '2026-01-02 00:00:00'),
    ('fixture-9', '{OLD}', 'main', 'a key that carries no tenant', '2026-01-02 00:00:00'),
    ('{OLD}-main', '{OLD}', 'main', 'a key that is exactly tenant and source', '2026-01-02 00:00:00');
CREATE TABLE bronze_example.colon_items (unique_key String, tenant_id Nullable(String), source_id Nullable(String),
    _airbyte_extracted_at DateTime64(3))
ENGINE = ReplacingMergeTree(_airbyte_extracted_at) ORDER BY unique_key;
INSERT INTO bronze_example.colon_items VALUES ('{OLD}:main:org/repo:1', '{OLD}', 'main', '2026-01-02 00:00:00');
CREATE TABLE bronze_bamboohr.whos_out (unique_key String, tenant_id Nullable(String), source_id Nullable(String),
    entries_json String, _airbyte_extracted_at DateTime64(3))
ENGINE = ReplacingMergeTree(_airbyte_extracted_at) ORDER BY unique_key;
INSERT INTO bronze_bamboohr.whos_out VALUES ('["{OLD}","bamboo"]', '{OLD}', 'bamboo', '[]', '2026-01-02 00:00:00');
CREATE TABLE bronze_youtrack.youtrack_comments (unique_key String, tenant_id Nullable(String), source_id Nullable(String),
    id Nullable(String), _airbyte_extracted_at DateTime64(3))
ENGINE = ReplacingMergeTree(_airbyte_extracted_at) ORDER BY unique_key;
INSERT INTO bronze_youtrack.youtrack_comments VALUES ('{OLD}-yt-4-17', '{OLD}', 'yt', NULL, '2026-01-02 00:00:00');
CREATE TABLE staging.jira__catalogue_first_seen (unique_key String, tenant_id String, insight_source_id String,
    catalogue_first_sync DateTime64(3), recorded_at DateTime64(3), _version UInt64)
ENGINE = ReplacingMergeTree(_version) ORDER BY unique_key;
INSERT INTO staging.jira__catalogue_first_seen VALUES ('{OLD}-main', '{OLD}', 'main', '2026-01-01 00:00:00', '2026-01-01 00:05:00', 1);
CREATE TABLE staging.slack__users_snapshot (unique_key Nullable(String), tenant_id Nullable(String),
    source_id Nullable(String), name String, _tracked_at DateTime64(3))
ENGINE = MergeTree ORDER BY tuple();
INSERT INTO staging.slack__users_snapshot VALUES
    ('{OLD}-slack-U1', '{OLD}', 'slack', 'first version', '2026-01-01 00:00:00'),
    ('{OLD}-slack-U1', '{OLD}', 'slack', 'second version', '2026-01-02 00:00:00'),
    (NULL, '{OLD}', 'slack', 'a row without a key', '2026-01-02 00:00:00');
CREATE TABLE staging.youtrack__field_observations (unique_key String, insight_source_id String, field_id String,
    observed_at DateTime64(3), _version UInt64)
ENGINE = ReplacingMergeTree(_version) ORDER BY unique_key SETTINGS allow_nullable_key = 1;
INSERT INTO staging.youtrack__field_observations VALUES
    ('{OLD}-yt-field-1-2026-01-01 00:00:00', 'yt', 'field-1', '2026-01-01 00:00:00', 1);
CREATE TABLE config.task_value_map (unique_key String, tenant_id String, insight_source_id String, value String,
    _version DateTime64(3))
ENGINE = ReplacingMergeTree(_version) ORDER BY unique_key;
INSERT INTO config.task_value_map VALUES ('{OLD}:main:status:open', '{OLD}', 'main', 'open', '2026-01-01 00:00:00');
CREATE TABLE ingestion_history.sync_events (ts DateTime64(3), tenant_id LowCardinality(String),
    source_id LowCardinality(String), event LowCardinality(String))
ENGINE = MergeTree ORDER BY (event, ts);
INSERT INTO ingestion_history.sync_events VALUES ('2026-01-01 00:00:00', '{OLD}', 'main', 'sync'), ('2026-01-01 00:00:01', '', 'main', 'sync')
"""


@pytest.fixture(scope="module")
def ch() -> ClickHouse:
    url = os.environ.get("TENANT_MIGRATION_TEST_CH_URL")
    if not url:
        pytest.skip("TENANT_MIGRATION_TEST_CH_URL is not set")
    os.environ.update(
        CLICKHOUSE_URL=url,
        CLICKHOUSE_USER=os.environ.get("TENANT_MIGRATION_TEST_CH_USER", "default"),
        CLICKHOUSE_PASSWORD=os.environ.get("TENANT_MIGRATION_TEST_CH_PASSWORD", ""),
    )
    return ClickHouse.from_env()


@pytest.fixture
def warehouse(ch: ClickHouse, monkeypatch: pytest.MonkeyPatch) -> ClickHouse:
    monkeypatch.setenv("INSIGHT_TENANT_ID", NEW)
    for statement in RESET:
        ch.execute(statement)
    for statement in (s.strip() for s in SCHEMA.split(";\n")):
        if statement:
            ch.execute(statement)
    return ch


def _plan(ch: ClickHouse) -> list[TablePlan]:
    return survey(ch, discover(ch, history_relations()), NEW)


def _apply(ch: ClickHouse) -> list[str]:
    return migration.apply(ch, _plan(ch), NEW)


def _fingerprint(ch: ClickHouse) -> dict[str, tuple[str, ...]]:
    return {t: tuple(ch.rows(f"SELECT count(), sum(cityHash64(*)) FROM {t}")[0]) for t in TABLES}


def _work_tables(ch: ClickHouse) -> list[str]:
    return [name for (name,) in ch.rows("SELECT name FROM system.tables WHERE position(name, '__tenant_') > 0")]


def _column(ch: ClickHouse, table: str, column: str) -> list[str]:
    database, name = table.split(".")
    replacing = ch.scalar(
        f"SELECT count() FROM system.tables WHERE database = '{database}' AND name = '{name}' AND engine LIKE '%Replacing%'"
    )
    final = "FINAL" if replacing else ""
    return [row[0] for row in ch.rows(f"SELECT ifNull(toString({column}), 'NULL') FROM {table} {final} ORDER BY 1")]


def _columns(ch: ClickHouse, table: str) -> list[tuple[str, str]]:
    database, name = table.split(".")
    return [
        (column, column_type)
        for column, column_type in ch.rows(
            f"SELECT name, type FROM system.columns WHERE database = '{database}' AND table = '{name}' ORDER BY position"
        )
    ]


def test_a_plan_counts_what_moves_and_writes_nothing(warehouse: ClickHouse) -> None:
    before = _fingerprint(warehouse)

    plans = {p.table.relation: p for p in _plan(warehouse)}

    assert plans["bronze_example.items"].moving == 5
    assert plans["ingestion_history.sync_events"].moving == 2
    assert all(plans[t].pending for t in TABLES)
    assert _fingerprint(warehouse) == before


@pytest.mark.parametrize(
    ("table", "column", "expected"),
    [
        (
            "bronze_example.items",
            "unique_key",
            sorted([f"{NEW}-main-PROJ-7", f"{NEW}-main-PROJ-8", f"{NEW}-main-PROJ-9", "fixture-9", f"{NEW}-main"]),
        ),
        ("bronze_example.items", "insight_tenant_id", [NEW] * 5),
        ("bronze_example.colon_items", "unique_key", [f"{NEW}:main:org/repo:1"]),
        ("bronze_bamboohr.whos_out", "unique_key", [f'["{NEW}","bamboo"]']),
        ("bronze_youtrack.youtrack_comments", "id", ["4-17"]),
        ("staging.jira__catalogue_first_seen", "unique_key", [f"{NEW}-main"]),
        ("staging.slack__users_snapshot", "unique_key", sorted([f"{NEW}-slack-U1", f"{NEW}-slack-U1", "NULL"])),
        ("staging.youtrack__field_observations", "insight_tenant_id", [NEW]),
        ("config.task_value_map", "unique_key", [f"{NEW}:main:status:open"]),
        ("ingestion_history.sync_events", "tenant_id", [NEW, NEW]),
    ],
)
def test_apply_moves_every_key_form_to_the_tenant(
    warehouse: ClickHouse, table: str, column: str, expected: list[str]
) -> None:
    _apply(warehouse)

    assert _column(warehouse, table, column) == expected, f"{table}.{column}"


def test_the_tenant_column_is_renamed_in_place_with_its_type_and_the_ledger_keeps_its_name(
    warehouse: ClickHouse,
) -> None:
    _apply(warehouse)

    assert _columns(warehouse, "bronze_example.items") == [
        ("unique_key", "String"),
        ("insight_tenant_id", "Nullable(String)"),
        ("source_id", "Nullable(String)"),
        ("payload", "String"),
        ("_airbyte_extracted_at", "DateTime64(3)"),
    ]
    assert ("insight_tenant_id", "String") in _columns(warehouse, "staging.jira__catalogue_first_seen")
    assert ("tenant_id", "LowCardinality(String)") in _columns(warehouse, "ingestion_history.sync_events")


def test_a_history_relation_without_a_tenant_gains_it_after_its_key(warehouse: ClickHouse) -> None:
    _apply(warehouse)

    assert _columns(warehouse, "staging.youtrack__field_observations")[:2] == [
        ("unique_key", "String"),
        ("insight_tenant_id", "Nullable(String)"),
    ]


def test_the_tenant_column_is_renamed_in_a_sorting_key_too(warehouse: ClickHouse) -> None:
    warehouse.execute(
        "CREATE TABLE bronze_example.keyed (tenant_id Nullable(String), source_id Nullable(String), "
        "unique_key String) ENGINE = MergeTree ORDER BY (tenant_id, unique_key) SETTINGS allow_nullable_key = 1"
    )
    warehouse.execute(f"INSERT INTO bronze_example.keyed VALUES ('{NEW}', 'main', '{NEW}-main-1')")

    _apply(warehouse)

    assert warehouse.rows(
        "SELECT sorting_key FROM system.tables WHERE database = 'bronze_example' AND name = 'keyed'"
    ) == [["insight_tenant_id, unique_key"]]


def test_the_entity_written_twice_keeps_its_newest_row(warehouse: ClickHouse) -> None:
    _apply(warehouse)

    payload = warehouse.rows(f"SELECT payload FROM bronze_example.items FINAL WHERE unique_key = '{NEW}-main-PROJ-7'")
    assert payload == [["the old tenant, whose own key holds the source name"]]


def test_each_original_is_kept_as_its_backup(warehouse: ClickHouse) -> None:
    before = _fingerprint(warehouse)

    _apply(warehouse)

    backups = {
        t: tuple(warehouse.rows(f"SELECT count(), sum(cityHash64(*)) FROM {t}__tenant_backup")[0]) for t in TABLES
    }
    assert backups == before


def test_a_second_run_finds_nothing_and_changes_nothing(warehouse: ClickHouse) -> None:
    _apply(warehouse)
    after = _fingerprint(warehouse)

    assert not any(p.pending for p in _plan(warehouse))
    assert _apply(warehouse) == []
    assert _fingerprint(warehouse) == after


def test_a_later_run_leaves_an_earlier_backup_alone_and_takes_the_next_name(warehouse: ClickHouse) -> None:
    _apply(warehouse)
    first_backup = warehouse.rows("SELECT count(), sum(cityHash64(*)) FROM bronze_example.items__tenant_backup")
    warehouse.execute(
        "INSERT INTO bronze_example.items VALUES ('-main-PROJ-20', NULL, 'main', 'late, without a tenant', now())"
    )

    assert _apply(warehouse) == ["bronze_example.items"]

    assert warehouse.rows("SELECT count(), sum(cityHash64(*)) FROM bronze_example.items__tenant_backup") == first_backup
    assert warehouse.scalar("SELECT uniqExact(unique_key) FROM bronze_example.items__tenant_backup_2") == 6
    assert f"{NEW}-main-PROJ-20" in _column(warehouse, "bronze_example.items", "unique_key")


def test_a_table_holding_both_tenant_columns_stops_the_run_before_anything_changes(warehouse: ClickHouse) -> None:
    warehouse.execute(
        "CREATE TABLE bronze_example.both (tenant_id Nullable(String), insight_tenant_id Nullable(String)) "
        "ENGINE = MergeTree ORDER BY tuple()"
    )

    with pytest.raises(InventoryError, match="both tenant_id and insight_tenant_id"):
        discover(warehouse, history_relations())


@dataclass(frozen=True)
class Failing(ClickHouse):
    """ClickHouse that fails the `nth` statement starting with `at`; with `lost`, after running it."""

    at: str = ""
    nth: int = 1
    lost: bool = False
    seen: list[str] = field(default_factory=list)

    def execute(self, sql: str, *, fmt: str | None = None) -> str:
        if sql.lstrip().startswith(self.at):
            self.seen.append(sql)
            if len(self.seen) == self.nth:
                if self.lost:
                    super().execute(sql, fmt=fmt)
                raise ClickHouseError("synthetic failure")
        return super().execute(sql, fmt=fmt)


FAILURES = {
    "the third copy fails": {"at": "INSERT INTO", "nth": 3},
    "the fourth swap fails": {"at": "EXCHANGE TABLES", "nth": 4},
    "the reply to the fourth swap is lost": {"at": "EXCHANGE TABLES", "nth": 4, "lost": True},
    "the last swap's reply is lost": {"at": "EXCHANGE TABLES", "nth": len(TABLES), "lost": True},
}


@pytest.mark.parametrize("where", FAILURES.values(), ids=FAILURES.keys())
def test_a_run_that_fails_part_way_puts_every_table_back_and_leaves_no_copy(
    warehouse: ClickHouse, where: dict[str, object]
) -> None:
    before = _fingerprint(warehouse)
    failing = Failing(url=warehouse.url, user=warehouse.user, password=warehouse.password, **where)

    with pytest.raises(migration.MigrationError, match="every table is back as it was"):
        migration.apply(failing, _plan(warehouse), NEW)

    assert _fingerprint(warehouse) == before
    assert _work_tables(warehouse) == []
    assert ("tenant_id", "Nullable(String)") in _columns(warehouse, "bronze_example.items")


def test_an_interrupt_mid_run_puts_every_table_back(warehouse: ClickHouse) -> None:
    before = _fingerprint(warehouse)

    @dataclass(frozen=True)
    class Interrupted(Failing):
        def execute(self, sql: str, *, fmt: str | None = None) -> str:
            if sql.lstrip().startswith("EXCHANGE TABLES") and len(self.seen) == 2:
                raise KeyboardInterrupt("stopped by signal 15")
            if sql.lstrip().startswith("EXCHANGE TABLES"):
                self.seen.append(sql)
            return ClickHouse.execute(self, sql, fmt=fmt)

    interrupted = Interrupted(url=warehouse.url, user=warehouse.user, password=warehouse.password)
    with pytest.raises(migration.MigrationError, match="signal 15"):
        migration.apply(interrupted, _plan(warehouse), NEW)

    assert _fingerprint(warehouse) == before
    assert _work_tables(warehouse) == []


def test_finalize_drops_every_backup_and_only_backups(warehouse: ClickHouse) -> None:
    _apply(warehouse)
    after = _fingerprint(warehouse)

    dropped = migration.finalize(warehouse)

    assert len(dropped) == len(TABLES)
    assert _work_tables(warehouse) == []
    assert _fingerprint(warehouse) == after


def test_the_command_line_plans_applies_and_finalizes(
    warehouse: ClickHouse, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["plan", "--exit-code"]) == 1
    assert main(["plan"]) == 0
    assert f"tenant: {NEW} (from INSIGHT_TENANT_ID)" in capsys.readouterr().out
    assert main(["apply"]) == 0
    assert main(["plan", "--exit-code"]) == 0
    assert "tables changing: 0" in capsys.readouterr().out
    assert main(["finalize"]) == 0
    assert _work_tables(warehouse) == []


@pytest.mark.parametrize(
    "value", [None, "", NEW.upper(), "example-legacy"], ids=["unset", "empty", "upper", "not a uuid"]
)
def test_the_command_line_refuses_a_missing_or_malformed_tenant(
    warehouse: ClickHouse, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], value: str | None
) -> None:
    before = _fingerprint(warehouse)
    if value is None:
        monkeypatch.delenv("INSIGHT_TENANT_ID", raising=False)
    else:
        monkeypatch.setenv("INSIGHT_TENANT_ID", value)

    assert main(["apply"]) == 2
    assert "INSIGHT_TENANT_ID" in capsys.readouterr().err
    assert _fingerprint(warehouse) == before


def test_the_command_line_takes_no_tenant_flag(warehouse: ClickHouse) -> None:
    with pytest.raises(SystemExit):
        main(["apply", "--tenant", NEW])
