"""Rig for the absent-bronze lane: the cold-start rig, plus bronze a test lays down.

The warehouse, the reset and `run-dbt.sh` are the cold-start lane's own
(`tests/cold_start/conftest.py`), loaded under another module name so both
suites keep one copy of them. What this lane adds is a way to stand up a bronze
table in a given state: absent, present and empty, or present with rows.
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

_RIG = Path(__file__).resolve().parents[1] / "cold_start" / "conftest.py"
_spec = importlib.util.spec_from_file_location("cold_start_rig", _RIG)
assert _spec and _spec.loader
rig = importlib.util.module_from_spec(_spec)
sys.modules["cold_start_rig"] = rig
_spec.loader.exec_module(rig)

Warehouse = rig.Warehouse
DBT_DIR = rig.DBT_DIR
TIMEOUT_S = rig.TIMEOUT_S

#: The canonical tenant a Bronze row must carry (bronze_tenant()).
TENANT = "22222222-2222-4222-8222-222222222222"

warehouse = rig.warehouse


@pytest.fixture
def fresh_install(warehouse: Warehouse) -> Iterator[Warehouse]:
    """A warehouse holding exactly what a deploy creates, per test: every test
    here lays down its own bronze, so none may see another's."""
    for database in warehouse.databases():
        warehouse.execute("DROP DATABASE IF EXISTS {database:Identifier}", {"database": database})
    created = subprocess.run(
        ["bash", str(rig.CREATE_DATABASES)],
        env=warehouse.env,
        capture_output=True,
        text=True,
        check=False,
        timeout=TIMEOUT_S,
    )
    if created.returncode != 0:
        pytest.fail(f"create-databases.sh failed:\n{created.stdout[-4000:]}\n{created.stderr[-4000:]}", pytrace=False)
    yield warehouse


def dbt(warehouse: Warehouse, *args: str) -> subprocess.CompletedProcess[str]:
    """The suite's dbt against the warehouse, judging nothing about how it went."""
    return subprocess.run(
        [str(Path(sys.executable).parent / "dbt"), *args, "--profiles-dir", str(warehouse.profiles_dir)],
        env=warehouse.env,
        cwd=DBT_DIR,
        capture_output=True,
        text=True,
        check=False,
        timeout=TIMEOUT_S,
    )


def unbuildable(warehouse: Warehouse, selected: str | None = None) -> dict[str, str]:
    """name -> reason, as `list_unbuildable_models` reports it (optionally for one run's selection)."""
    args = "{reasons: true" + (f", selected: '{selected}'" if selected is not None else "") + "}"
    completed = dbt(warehouse, "--quiet", "run-operation", "list_unbuildable_models", "--args", args)
    assert completed.returncode == 0, completed.stdout[-4000:] + completed.stderr[-4000:]
    report = {}
    for line in completed.stdout.splitlines():
        name, _, reason = line.partition("\t")
        report[name] = reason
    return report
