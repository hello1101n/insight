"""The seeded dataset: synthetic records, one a day for each team."""

from __future__ import annotations

import datetime as _dt
import json
from dataclasses import dataclass
from typing import Final

from .definition import Body


@dataclass(frozen=True)
class DatasetRecord:
    team: str
    points: int
    at: str

    def raw_data(self) -> str:
        return json.dumps({"team": self.team, "points": self.points, "at": self.at}, sort_keys=True)


DATASET_NAME: Final = "stand_sample_records"
DATASET_DECLARATION: Final[Body] = {
    "title": "Stand sample records",
    "description": "Synthetic records, one a day for each team.",
    "fields": [
        {"name": "team", "path": "team", "type": "string", "role": "dimension"},
        {"name": "points", "path": "points", "type": "int", "role": "measurable"},
        {"name": "at", "path": "at", "type": "datetime", "role": "time", "default_clock": True},
    ],
}

_DATASET_TEAMS: Final = ("Atlas", "Borealis", "Cobalt", "Delta")
_DATASET_DAYS: Final = 30


def dataset_records(anchor: _dt.date) -> tuple[DatasetRecord, ...]:
    """One record a day for each team over the 30 days that end at the anchor."""
    records = []
    for offset in range(_DATASET_DAYS):
        day = anchor - _dt.timedelta(days=offset)
        for index, team in enumerate(_DATASET_TEAMS):
            records.append(
                DatasetRecord(team, (offset * 7 + index * 3) % 20, f"{day.isoformat()}T12:00:00Z")
            )
    return tuple(records)
