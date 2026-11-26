"""`union_by_tag` keeps one row per `unique_key`: the one with the newest version.

The SQL is compiled from the real macros, then read from probe tables, so the
rows can carry the NULL keys, NULL versions and ties that no YouTrack model
emits, across more than one arm.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from conftest import DBT, Warehouse
from dbt.cli.main import dbtRunner

ARM_MODEL = "youtrack__task_comments"
PROBES = ("union_probe_a", "union_probe_b")
WIDE_PROBE = "union_probe_wide"
WIDE_ROWS = 20_000
WIDE_VALUE_BYTES = 20_000
MEMORY_LIMIT_BYTES = 150_000_000


def compiled(case: Warehouse, inline: str) -> str:
    result = dbtRunner().invoke(
        ["compile", "--project-dir", str(DBT), "--profiles-dir", str(case.profile), "--quiet", "--inline", inline]
    )
    assert result.success, result.exception
    return result.result.results[0].node.compiled_code


def latest_over(case: Warehouse, tables: tuple[str, ...]) -> str:
    relations = ", ".join(f"api.Relation.create(schema='staging', identifier='{t}')" for t in tables)
    return compiled(case, f"{{{{ union_relations_latest([{relations}], '_version') }}}}")


@pytest.fixture
def probes(case: Warehouse) -> Iterator[Warehouse]:
    for table in (*PROBES, WIDE_PROBE):
        case.client.command(f"DROP TABLE IF EXISTS staging.{table}")
    yield case
    for table in (*PROBES, WIDE_PROBE):
        case.client.command(f"DROP TABLE IF EXISTS staging.{table}")


def test_union_by_tag_reads_every_arm_of_the_class(case: Warehouse) -> None:
    case.build()
    sql = compiled(
        case, f"-- depends_on: {{{{ ref('{ARM_MODEL}') }}}}\n{{{{ union_by_tag('silver:class_task_comments') }}}}"
    )
    union = sql.split("\n", 1)[1]
    assert union.count(f"`staging`.`{ARM_MODEL}`") == 2, f"should read the arm for versions and for rows: {union}"


def test_the_newest_version_of_a_key_wins_across_arms(probes: Warehouse) -> None:
    for table in PROBES:
        probes.client.command(
            f"CREATE TABLE staging.{table} (unique_key Nullable(String), _version Nullable(UInt64), label String) "
            "ENGINE = MergeTree ORDER BY tuple()"
        )
    probes.client.command("""INSERT INTO staging.union_probe_a VALUES
        ('changed', 1, 'stale'), ('changed', 3, 'newest'),
        ('copied', 5, 'copy'),
        ('versioned', NULL, 'stale'),
        ('unversioned', NULL, 'only'),
        (NULL, 1, 'stale')""")
    probes.client.command("""INSERT INTO staging.union_probe_b VALUES
        ('changed', 2, 'stale'),
        ('copied', 5, 'copy'),
        ('versioned', 2, 'newest'),
        ('unversioned', NULL, 'only'),
        (NULL, 4, 'newest')""")

    union = latest_over(probes, PROBES)
    rows = sorted(
        (str(row["unique_key"]), str(row["_version"]), row["label"])
        for row in probes.rows(f"SELECT unique_key, _version, label FROM ({union})")
    )

    assert rows == [
        ("None", "4", "newest"),
        ("changed", "3", "newest"),
        ("copied", "5", "copy"),
        ("unversioned", "None", "only"),
        ("versioned", "2", "newest"),
    ], f"should keep one newest row per key, NULL keys and versions included: {rows}"


def test_the_union_does_not_hold_wide_rows_in_memory(probes: Warehouse) -> None:
    probes.client.command(
        f"CREATE TABLE staging.{WIDE_PROBE} (unique_key String, _version UInt64, body String) "
        "ENGINE = MergeTree ORDER BY tuple()"
    )
    probes.client.command(
        f"INSERT INTO staging.{WIDE_PROBE} SELECT toString(number % {WIDE_ROWS // 2}), number, "
        f"repeat('x', {WIDE_VALUE_BYTES}) FROM numbers({WIDE_ROWS})"
    )

    union = latest_over(probes, (WIDE_PROBE,))
    rows = probes.client.query(
        f"SELECT count(), sum(length(body)) FROM ({union})", settings={"max_memory_usage": MEMORY_LIMIT_BYTES}
    ).result_rows

    assert rows == [(WIDE_ROWS // 2, WIDE_ROWS // 2 * WIDE_VALUE_BYTES)], (
        f"should read {WIDE_ROWS} rows of {WIDE_VALUE_BYTES} bytes within {MEMORY_LIMIT_BYTES} bytes: {rows}"
    )
