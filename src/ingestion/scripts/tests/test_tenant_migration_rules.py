"""The rules the tenant migration applies before it touches a warehouse."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tenant_migration import ddl
from tenant_migration.__main__ import main
from tenant_migration.inventory import InventoryError, Relation, Table, classify
from tenant_migration.keys import TenantError, parse_tenant

NEW = "0f6b3c2e-5d4a-4e7b-9c1d-2a3b4c5d6e7f"
STRING = "Nullable(String)"


@pytest.mark.parametrize("value", [None, "", NEW.upper(), "example-legacy", f"{NEW} "])
def test_only_a_lowercase_uuid_is_a_tenant(value: str | None) -> None:
    with pytest.raises(TenantError):
        parse_tenant(value, "INSIGHT_TENANT_ID")


def test_a_lowercase_uuid_is_the_tenant() -> None:
    assert parse_tenant(NEW, "INSIGHT_TENANT_ID") == NEW


def _classify(database: str, columns: dict[str, str], *, history: bool = False) -> Table | None:
    return classify(database, "t", "ReplacingMergeTree", list(columns.items()), history=history)


@pytest.mark.parametrize(
    ("database", "column", "renames"),
    [
        ("bronze_example", "tenant_id", True),
        ("staging", "tenant_id", True),
        ("config", "tenant_id", True),
        ("bronze_example", "insight_tenant_id", False),
        ("ingestion_history", "tenant_id", False),
    ],
)
def test_the_tenant_column_is_renamed_everywhere_but_the_sync_ledger(database: str, column: str, renames: bool) -> None:
    table = _classify(database, {column: STRING, "source_id": STRING})

    assert table is not None and table.renames is renames and not table.adds


def test_a_history_relation_without_a_tenant_gains_one_and_any_other_table_is_out_of_scope() -> None:
    columns = {"unique_key": "String", "insight_source_id": "String"}

    history = _classify("staging", columns, history=True)

    assert history is not None and history.adds and history.target == "insight_tenant_id"
    assert _classify("bronze_example", columns) is None


@pytest.mark.parametrize(
    "columns",
    [{"tenant_id": STRING, "insight_tenant_id": STRING}, {"tenant_id": "UUID"}],
    ids=["both tenant columns", "tenant not a string"],
)
def test_a_table_the_migration_cannot_read_stops_it(columns: dict[str, str]) -> None:
    with pytest.raises(InventoryError):
        _classify("bronze_example", columns)


def test_only_the_youtrack_comments_fill_their_ids_from_the_key() -> None:
    columns = [("unique_key", "String"), ("tenant_id", STRING), ("source_id", STRING), ("id", STRING)]

    comments = classify("bronze_youtrack", "youtrack_comments", "ReplacingMergeTree", columns, history=False)
    other = classify("bronze_youtrack", "youtrack_issues", "ReplacingMergeTree", columns, history=False)

    assert comments is not None and comments.comment_id == "id"
    assert other is not None and other.comment_id is None


def test_the_renamed_ddl_names_the_new_column_in_its_definition_and_keys_only() -> None:
    create = (
        "CREATE TABLE `bronze_example`.`items__tenant_backup`\n(\n    `unique_key` String,\n"
        "    `tenant_id` Nullable(String),\n    `azure_tenant_id` Nullable(String)\n)\n"
        "ENGINE = ReplacingMergeTree\nORDER BY (tenant_id, unique_key)"
    )

    renamed = ddl.tenant_renamed(create)

    assert "`insight_tenant_id` Nullable(String)" in renamed
    assert "`azure_tenant_id` Nullable(String)" in renamed
    assert "ORDER BY (insight_tenant_id, unique_key)" in renamed


@pytest.mark.parametrize(
    "saved",
    [
        "CREATE TABLE bronze_example.items\n(\n    `unique_key` String\n)\nENGINE = MergeTree",
        "CREATE TABLE bronze_example.items UUID 'a5c2b1e4-0000-4000-8000-000000000001'\n(\n    `unique_key` String\n)",
    ],
    ids=["plain", "with its uuid"],
)
def test_the_copy_ddl_names_the_backup_and_no_uuid(saved: str) -> None:
    retargeted = ddl.retarget(saved, Relation("bronze_example", "items"), "__tenant_backup")

    assert retargeted.startswith("CREATE TABLE `bronze_example`.`items__tenant_backup`\n")
    assert "UUID" not in retargeted


def test_ddl_that_is_not_a_create_table_is_refused() -> None:
    with pytest.raises(ddl.DdlError):
        ddl.retarget("ATTACH TABLE x", Relation("bronze_example", "items"), "__tenant_backup")


def test_an_unreachable_clickhouse_is_reported_as_an_error_not_a_traceback(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("CLICKHOUSE_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("CLICKHOUSE_USER", "u")
    monkeypatch.setenv("CLICKHOUSE_PASSWORD", "p")
    monkeypatch.setenv("INSIGHT_TENANT_ID", NEW)

    assert main(["plan"]) == 2
    assert "unreachable" in capsys.readouterr().err
