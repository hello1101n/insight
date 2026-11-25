"""The custom catalogue a compose stand carries: metrics, widgets and dashboards.

These are the definitions that `insight-v3-core` serves at `/api/v3` and that
the portal draws at `/dashboards/<id>`. Each dashboard tests one thing a
renderer must get right, and its name says which. Every metric reads a silver
table the seed fills, or the one dataset declared here, so each widget draws
seeded rows and no number in this module is an expected value.

Pure data: no environment reads, no I/O. `custom_catalogue_store` writes it, and
`manifest` describes it. The ids are fixed, so a re-seed replaces the same rows
and a test or a person can open a board by its path.
"""

from __future__ import annotations

from typing import TypedDict

from .boards import BOARDS, FOLDER_ID, FOLDER_NAME, Board
from .dataset import DATASET_DECLARATION, DATASET_NAME, DatasetRecord, dataset_records
from .definition import ID_PREFIX, Body, Definition
from .metrics import METRICS, MISSING_COLUMN, NO_SUCH_STATE
from .widgets import FAILING_WIDGETS, WIDGETS


class WidgetEntry(TypedDict):
    id: str
    name: str


class BoardEntry(TypedDict):
    id: str
    name: str
    path: str
    covers: str
    widgets: list[WidgetEntry]
    failing_widgets: list[str]


class CatalogueDoc(TypedDict):
    """The `custom_catalogue` field of the manifest: the boards, by a stable key."""

    dashboards: dict[str, BoardEntry]
    dataset: str
    folder: str


def describe() -> CatalogueDoc:
    """What the manifest says about the seeded catalogue."""
    names = {widget.id: widget.name for widget in WIDGETS}
    return {
        "dashboards": {
            board.key: {
                "id": board.id,
                "name": board.name,
                "path": board.path,
                "covers": board.covers,
                "widgets": [{"id": w, "name": names[w]} for w in board.widgets],
                "failing_widgets": [w for w in board.widgets if w in FAILING_WIDGETS],
            }
            for board in BOARDS
        },
        "dataset": DATASET_NAME,
        "folder": FOLDER_NAME,
    }


__all__ = [
    "BOARDS",
    "DATASET_DECLARATION",
    "DATASET_NAME",
    "FAILING_WIDGETS",
    "FOLDER_ID",
    "FOLDER_NAME",
    "ID_PREFIX",
    "METRICS",
    "MISSING_COLUMN",
    "NO_SUCH_STATE",
    "WIDGETS",
    "Board",
    "BoardEntry",
    "Body",
    "CatalogueDoc",
    "DatasetRecord",
    "Definition",
    "WidgetEntry",
    "dataset_records",
    "describe",
]
