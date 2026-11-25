"""The seeded dashboards: each tests one thing a dashboard renderer must draw."""

from __future__ import annotations

import uuid as uuid_mod
from dataclasses import dataclass
from typing import Final

from .definition import ID_PREFIX, Body

#: Folder ids are UUIDs in the schema, so they come from this namespace.
_FOLDER_NAMESPACE: Final = uuid_mod.UUID("5eed0000-0000-4000-8000-00000000f01d")


@dataclass(frozen=True)
class Board:
    """A dashboard, with what it tests and where it sits."""

    key: str
    name: str
    covers: str
    body: Body
    shared_with_ceo: bool = False
    starred: bool = False
    in_folder: bool = False

    @property
    def widgets(self) -> tuple[str, ...]:
        return tuple(item["widget"] for item in self.body["items"] if "widget" in item)

    @property
    def id(self) -> str:
        return f"{ID_PREFIX}{self.key.replace('_', '-')}"

    @property
    def path(self) -> str:
        return f"/dashboards/{self.id}"


def _w(*slugs: str) -> list[Body]:
    return [{"widget": f"stand-w-{slug}"} for slug in slugs]


def _ranged(title: str, items: list[Body], ranges: list[str], default: str) -> Body:
    return {"title": title, "time_ranges": ranges, "default_range": default, "items": items}


_MARKDOWN_TEXT: Final = (
    "Markdown stays literal: **bold**, _italic_, `code`, # not a heading, "
    "[a link](https://example.com), <b>a tag</b>, 5 * 3 = 15, a | b | c, & an ampersand."
)

BOARDS: Final[tuple[Board, ...]] = (
    Board(
        "every_widget_type",
        "Stand: every widget type",
        "line, area, bar, bar with labels, stacked bar, pie, stat and table, with time ranges",
        _ranged(
            "Every widget type",
            [
                {"heading": "Trends"},
                *_w("prs-line", "merged-area"),
                {"heading": "Breakdowns"},
                *_w("commits-bar", "state-bar-labels", "ci-stacked-bar", "state-pie"),
                {"heading": "Figures"},
                *_w("prs-stat", "ci-success-table"),
            ],
            ["P7D", "P30D", "P1Y"],
            "P30D",
        ),
    ),
    Board(
        "headings_and_texts",
        "Stand: headings and texts",
        "headings, texts, a long heading, and text with markdown-like characters",
        {
            "title": "Headings and texts",
            "items": [
                {"heading": "A plain heading"},
                {"text": "A plain line of text between widgets."},
                *_w("state-pie"),
                {
                    "heading": "A heading long enough to wrap onto a second line when "
                    "the window is narrow, so a renderer must wrap it"
                },
                {"text": _MARKDOWN_TEXT},
                {"text": "Two lines of text.\nThe second line follows a line break."},
                *_w("state-table"),
                {"heading": "A heading with no widget under it"},
            ],
        },
    ),
    Board(
        "no_time_range",
        "Stand: no time range, widgets with and without a clock",
        "a board without time ranges; clocked and clockless widgets run over all rows",
        {
            "title": "No time range",
            "items": [
                {"heading": "With a clock"},
                *_w("prs-stat", "commits-bar"),
                {"heading": "Without a clock"},
                *_w("state-pie", "deals-table"),
            ],
        },
    ),
    Board(
        "percents",
        "Stand: percent stat and percent column",
        "a percent stat, a percent table column, a percent line and percent bars",
        _ranged(
            "Percents",
            _w("merged-share-stat", "ci-success-table", "merged-share-line", "ci-success-bar"),
            ["P30D", "P1Y"],
            "P1Y",
        ),
    ),
    Board(
        "large_table",
        "Stand: table over 500 rows",
        "a table widget whose metric answers 1000 rows",
        {"title": "Table over 500 rows", "items": _w("pr-list")},
    ),
    Board(
        "many_categories",
        "Stand: many categories and long labels",
        "a bar over more than 50 categories, and bars and a table over long labels",
        {
            "title": "Many categories and long labels",
            "items": _w("deploys-bar", "wiki-bar", "wiki-table"),
        },
    ),
    Board(
        "dates_over_a_year",
        "Stand: dates over more than one year",
        "monthly buckets over the whole data window, which spans more than one year",
        _ranged(
            "Dates over more than one year",
            _w("prs-line", "merged-area", "prs-table"),
            ["inf", "P1Y", "P30D"],
            "inf",
        ),
    ),
    Board(
        "null_values",
        "Stand: null values",
        "null category labels, null ratios, a null stat and null table cells",
        {
            "title": "Null values",
            "items": _w(
                "deals-bar", "deals-table", "ci-ratio-table", "ci-ratio-bar", "latest-close-stat"
            ),
        },
    ),
    Board(
        "empty_results",
        "Stand: empty results",
        "a line, bars, a pie, a table and a stat over a metric with no rows",
        _ranged(
            "Empty results",
            _w("empty-line", "empty-bar", "empty-pie", "empty-table", "empty-stat"),
            ["P30D"],
            "P30D",
        ),
    ),
    Board(
        "failing_widget",
        "Stand: a widget that fails",
        "a widget whose metric reads a column the table does not have, beside one that works",
        {
            "title": "A widget that fails",
            "items": [
                {
                    "text": "The first widget names a column the table does not have, so its run fails."
                },
                *_w("missing-column-table", "state-pie"),
            ],
        },
    ),
    Board(
        "large_board",
        "Stand: large board with 18 widgets",
        "one board with 18 widgets of every type, under headings",
        _ranged(
            "Large board",
            [
                {"heading": "Pull requests"},
                *_w(
                    "prs-line",
                    "merged-area",
                    "prs-stat",
                    "merged-share-stat",
                    "merged-share-line",
                    "prs-table",
                ),
                {"heading": "States"},
                *_w("state-pie", "state-bar-labels", "state-table"),
                {"heading": "CI"},
                *_w("ci-stacked-bar", "ci-success-table", "ci-success-bar"),
                {"heading": "People and places"},
                *_w(
                    "commits-bar",
                    "commits-pie",
                    "deploys-bar",
                    "wiki-bar",
                    "deals-bar",
                    "sample-bar",
                ),
            ],
            ["P7D", "P30D", "P1Y"],
            "P30D",
        ),
    ),
    Board(
        "in_folder",
        "Stand: board in a folder",
        "a board filed in the folder `Stand folder`",
        {"title": "Board in a folder", "items": _w("prs-stat", "state-pie")},
        in_folder=True,
    ),
    Board(
        "shared",
        "Stand: board shared with the CEO",
        "a board the admin operator owns and shares with the CEO as a viewer",
        {"title": "Shared board", "items": _w("state-pie", "state-table")},
        shared_with_ceo=True,
    ),
    Board(
        "starred",
        "Stand: starred board",
        "a board the admin operator has starred",
        {"title": "Starred board", "items": _w("state-bar-labels", "commits-pie")},
        starred=True,
    ),
    Board(
        "dataset_widgets",
        "Stand: widgets over a dataset",
        "bars and a table over a metric that reads the seeded dataset",
        {"title": "Widgets over a dataset", "items": _w("sample-bar", "sample-table")},
    ),
)

FOLDER_NAME: Final = "Stand folder"
FOLDER_ID: Final = str(uuid_mod.uuid5(_FOLDER_NAMESPACE, FOLDER_NAME))
