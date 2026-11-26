"""`union_by_tag` keeps one row per `unique_key`, the latest `_version`.

It finds the latest version per key over the two narrow columns and keeps the
rows holding it, rather than numbering every whole row in a window: the same
rows, without sorting each wide row in memory. The window is the reference here.

The two staging arms of `class_support_tickets` are stood up by hand with a
narrow shape: `union_by_tag` reads whatever its materialised contributors hold.
"""

from __future__ import annotations

import subprocess

import pytest
from conftest import DBT_DIR, TIMEOUT_S, Warehouse

TAG = "silver:class_support_tickets"
ARMS = ("hubspot__support_tickets", "zendesk__support_tickets")
ROWS = {
    "hubspot__support_tickets": [
        ("only-once", 1, "a"),
        ("three-versions", 1, "old"),
        ("three-versions", 3, "newest"),
        ("three-versions", 2, "middle"),
        ("in-both-arms", 5, "hubspot, older"),
        ("tied", 7, "one"),
        ("tied", 7, "two"),
        ("tied", 6, "older"),
    ],
    "zendesk__support_tickets": [
        ("in-both-arms", 9, "zendesk, newer"),
        ("zendesk-only", 4, "z"),
        ("zendesk-only", 4, "z"),
    ],
}
UNION = " UNION ALL ".join(f"SELECT * FROM staging.{arm}" for arm in ARMS)
#: The dedup `union_by_tag` used before, as the reference.
WINDOW = f"SELECT * FROM ({UNION}) QUALIFY ROW_NUMBER() OVER (PARTITION BY unique_key ORDER BY _version DESC) = 1"


@pytest.fixture(scope="module")
def arms(fresh_install: Warehouse) -> Warehouse:
    for arm, rows in ROWS.items():
        fresh_install.execute(
            "CREATE TABLE staging.{arm:Identifier} (unique_key Nullable(String), _version UInt64, payload String) "
            "ENGINE = MergeTree ORDER BY tuple()",
            {"arm": arm},
        )
        with fresh_install.client() as client:
            client.insert(arm, rows, database="staging", column_names=["unique_key", "_version", "payload"])
    return fresh_install


def _union_by_tag(warehouse: Warehouse) -> str:
    """The SQL the macro emits for the tag, as `dbt compile --inline` renders it."""
    compiled = subprocess.run(
        [
            warehouse.dbt,
            "--quiet",
            "compile",
            "--inline",
            # An inline node has no parse-time refs; the hints let the macro's refs resolve.
            "".join(f"-- depends_on: {{{{ ref('{arm}') }}}}\n" for arm in ARMS) + f"{{{{ union_by_tag('{TAG}') }}}}",
            "--profiles-dir",
            str(warehouse.profiles_dir),
        ],
        env=warehouse.env,
        cwd=DBT_DIR,
        capture_output=True,
        text=True,
        check=False,
        timeout=TIMEOUT_S,
    )
    assert compiled.returncode == 0, compiled.stdout[-4000:] + compiled.stderr[-4000:]
    # --quiet leaves the compiled SQL alone on stdout, with no log lines after it.
    return "\n".join(line for line in compiled.stdout.splitlines() if not line.startswith("-- depends_on:")).strip()


def _rows(warehouse: Warehouse, sql: str) -> list[tuple[str, int, str]]:
    with warehouse.client() as client:
        return [
            tuple(r)
            for r in client.query(f"SELECT unique_key, _version, payload FROM ({sql}) ORDER BY ALL").result_rows
        ]


def test_the_union_keeps_the_rows_the_window_kept(arms: Warehouse) -> None:
    sql = _union_by_tag(arms)
    assert "ROW_NUMBER" not in sql
    assert all(f"`staging`.`{arm}`" in sql for arm in ARMS)

    kept, reference = _rows(arms, sql), _rows(arms, WINDOW)

    assert [r[:2] for r in kept] == [r[:2] for r in reference]
    untied = [r for r in kept if r[0] != "tied"]
    assert untied == [r for r in reference if r[0] != "tied"]
    assert ("in-both-arms", 9, "zendesk, newer") in kept
    assert ("three-versions", 3, "newest") in kept
    assert [r[2] for r in kept if r[0] == "tied"] in (["one"], ["two"])
