"""Collab staging builds every day extracted after its own newest build, once per key.

A window anchored on the newest bronze extract skips a day extracted more than
three days before it, so a gap in dbt runs strands that day forever. A window
anchored on the newest extract staging already built takes it on the next run.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, NamedTuple

import pytest
from insight_datapath import clickhouse
from insight_datapath.ch_seeder import CHSeeder
from insight_datapath.dbt_runner import DbtRunner
from insight_datapath.fixture_loader import load
from insight_datapath.instance import InstanceConfig
from insight_datapath.reset import clear
from insight_datapath.tracked_models import TrackedModels

pytestmark = pytest.mark.fixture

SPEC = "collab_staging_extract_gap"

FIRST_DAY = "2026-12-01"
GAP_DAY = "2026-12-02"
LATEST_DAY = "2026-12-03"
GAP_EXTRACT = "2030-01-02T00:00:00"
LATEST_EXTRACT = "2030-01-11T00:00:00"


class Feeder(NamedTuple):
    staging: str
    models: tuple[str, ...]
    bronze: dict[str, str]

    def later_rows(
        self, seeded: dict[str, list[dict[str, Any]]], day: str, extracted_at: str
    ) -> dict[str, list[dict[str, Any]]]:
        """The seeded first-day rows, moved to `day` and extracted at `extracted_at`."""
        return {
            table: [_moved(row, field, day, extracted_at) for row in seeded[table]]
            for table, field in self.bronze.items()
        }


FEEDERS = [
    Feeder(
        staging="staging.slack__collab_chat_activity",
        models=("slack__collab_chat_activity",),
        bronze={"bronze_slack.users_details": "date"},
    ),
    Feeder(
        staging="staging.m365__collab_email_activity",
        models=("m365__collab_email_activity",),
        bronze={"bronze_m365.email_activity": "reportRefreshDate"},
    ),
    Feeder(
        staging="staging.zoom__collab_meeting_activity",
        models=("zoom__meeting_sessions", "zoom__collab_meeting_activity"),
        bronze={
            "bronze_zoom.meetings": "start_time",
            "bronze_zoom.participants": "join_time",
        },
    ),
]


def _moved(row: dict[str, Any], field: str, day: str, extracted_at: str) -> dict[str, Any]:
    """A copy of `row` on `day`: every key and timestamp that names the first day moves."""
    month_day = day[5:].replace("-", "")
    moved = {key: _renamed(value, day, month_day) for key, value in row.items()}
    assert moved[field].startswith(day), f"should move {field} to {day}: {row[field]!r}"
    return {**moved, "_airbyte_extracted_at": extracted_at}


def _renamed(value: object, day: str, month_day: str) -> object:
    if not isinstance(value, str):
        return value
    return value.replace(FIRST_DAY, day).replace("1201", month_day)


@pytest.mark.parametrize("feeder", FEEDERS, ids=lambda f: f.staging)
def test_a_day_extracted_during_a_run_gap_is_built_once(
    feeder: Feeder,
    ch_seeder: CHSeeder,
    dbt_runner: DbtRunner,
    instance_cfg: InstanceConfig,
    tenant: str,
) -> None:
    fixture = load(Path(__file__).with_name(f"{SPEC}.test.yaml"), substitutions={"tenant": tenant})
    clear(ch_seeder.cfg, ch_seeder.ledger.drain())
    ch_seeder.seed_bronze(fixture.bronze, fixture.schemas)
    tracked = TrackedModels(dbt_runner, ch_seeder)
    tracked.run(feeder.models, full_refresh=True)

    for day, extracted_at in ((GAP_DAY, GAP_EXTRACT), (LATEST_DAY, LATEST_EXTRACT)):
        for table, rows in feeder.later_rows(fixture.bronze, day, extracted_at).items():
            schema, name = table.split(".")
            ch_seeder.seed_records(schema, name, rows)
    tracked.run(feeder.models)
    tracked.run(feeder.models)

    days = clickhouse.query(
        instance_cfg,
        f"SELECT DISTINCT toString(date) FROM {feeder.staging} ORDER BY 1",
    )
    assert [day for (day,) in days] == [FIRST_DAY, GAP_DAY, LATEST_DAY], (
        f"{feeder.staging} should build the day extracted during the gap"
    )

    [(rows, keys)] = clickhouse.query(
        instance_cfg,
        f"SELECT count(), uniqExact(unique_key) FROM {feeder.staging}",
    )
    assert rows == keys, f"{feeder.staging} should hold one row per key after repeated runs"
