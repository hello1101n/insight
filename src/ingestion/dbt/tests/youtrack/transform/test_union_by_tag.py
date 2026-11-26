"""`union_by_tag` keeps one row per `unique_key`: the one with the newest version.

The union is compiled from the real macro over a class this suite builds, then
read from a probe table in place of its staging arm, so the rows can carry the
NULL keys and ties that no YouTrack model emits.
"""

from __future__ import annotations

from conftest import DBT, Warehouse
from dbt.cli.main import dbtRunner

CLASS_TAG = "silver:class_task_comments"
ARM_MODEL = "youtrack__task_comments"
ARM = f"`staging`.`{ARM_MODEL}`"
PROBE = "`staging`.`union_by_tag_probe`"


def compiled_union(case: Warehouse) -> str:
    result = dbtRunner().invoke(
        [
            "compile",
            "--project-dir",
            str(DBT),
            "--profiles-dir",
            str(case.profile),
            "--quiet",
            "--inline",
            f"-- depends_on: {{{{ ref('{ARM_MODEL}') }}}}\n{{{{ union_by_tag('{CLASS_TAG}') }}}}",
        ]
    )
    assert result.success, result.exception
    sql = result.result.results[0].node.compiled_code
    assert ARM in sql, f"should read the YouTrack arm: {sql}"
    return sql.replace(ARM, PROBE)


def test_the_union_keeps_the_newest_version_of_each_key(case: Warehouse) -> None:
    case.build()
    union = compiled_union(case)
    case.client.command(f"DROP TABLE IF EXISTS {PROBE}")
    case.client.command(
        f"CREATE TABLE {PROBE} (unique_key Nullable(String), _version UInt64, label String) "
        "ENGINE = MergeTree ORDER BY tuple()"
    )
    case.client.command(f"""INSERT INTO {PROBE} VALUES
        ('changed', 1, 'stale'), ('changed', 3, 'newest'), ('changed', 2, 'stale'),
        ('copied', 5, 'copy'), ('copied', 5, 'copy'),
        ('single', 7, 'only'),
        (NULL, 1, 'stale'), (NULL, 4, 'newest')""")

    rows = sorted(
        (str(row["unique_key"]), row["_version"], row["label"])
        for row in case.rows(f"SELECT unique_key, _version, label FROM ({union})")
    )

    assert rows == [("None", 4, "newest"), ("changed", 3, "newest"), ("copied", 5, "copy"), ("single", 7, "only")], (
        f"should keep one newest row per key, a NULL key included: {rows}"
    )
