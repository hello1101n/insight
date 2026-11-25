"""The seeded custom catalogue holds together and covers what the renderers need.

The seed writes these definitions as rows, so the service does not check them
on the way in. These tests check what can be checked without a stand: every
reference resolves, every widget column is a column its metric answers, and the
boards together cover each case the dashboard renderers must draw. The stand
suite then runs every widget through the deployed service.
"""

from __future__ import annotations

import datetime as _dt
from collections import Counter
from collections.abc import Callable

import pytest

from insight_seed import custom_catalogue as cc
from insight_seed import custom_catalogue_store as store

_ANCHOR = _dt.date(2026, 6, 30)
_METRICS = {metric.id: metric for metric in cc.METRICS}
_WIDGETS = {widget.id: widget for widget in cc.WIDGETS}
_RANGE_TOKENS = {"PDC", "P7D", "P30D", "PMC", "PQC", "P1Y", "inf"}


#: The keys that name a metric column, per widget type, as the service reads them.
_COLUMN_KEYS = {
    "line": ("x", "y"),
    "area": ("x", "y"),
    "bar": ("x", "y", "series"),
    "pie": ("label", "value"),
    "stat": ("value",),
    "table": (),
}


def _columns(widget: cc.Definition) -> list[str]:
    body = widget.body
    named = [body[key] for key in _COLUMN_KEYS[body["type"]] if key in body]
    return named + list(body.get("columns", []))


def _clocked(metric: cc.Definition) -> bool:
    return "time" in metric.body or "dataset" in metric.body


def _answers(metric: cc.Definition) -> set[str]:
    names = {field["as_name"] for field in metric.body["fields"]}
    return names | ({"bucket"} if _clocked(metric) else set())


def _boards_where(predicate: Callable[[cc.Board], bool]) -> list[str]:
    return [board.key for board in cc.BOARDS if predicate(board)]


def _board(key: str) -> cc.Board:
    return next(board for board in cc.BOARDS if board.key == key)


def test_every_id_is_unique_and_carries_the_prefix_the_store_clears() -> None:
    ids = [d.id for d in (*cc.METRICS, *cc.WIDGETS)] + [board.id for board in cc.BOARDS]

    assert [i for i, n in Counter(ids).items() if n > 1] == []
    assert [i for i in ids if not i.startswith(cc.ID_PREFIX)] == []


def test_every_reference_resolves_and_every_widget_column_is_answered() -> None:
    problems = []
    for widget in cc.WIDGETS:
        metric = _METRICS.get(widget.body["metric"])
        if metric is None:
            problems.append(f"{widget.id}: no metric {widget.body['metric']}")
            continue
        missing = set(_columns(widget)) - _answers(metric)
        if missing:
            problems.append(f"{widget.id}: {metric.id} does not answer {sorted(missing)}")
    for board in cc.BOARDS:
        problems += [f"{board.key}: no widget {w}" for w in board.widgets if w not in _WIDGETS]

    assert problems == []


def test_every_board_offers_only_range_tokens_the_service_parses() -> None:
    for board in cc.BOARDS:
        offered = board.body.get("time_ranges", [])
        assert set(offered) <= _RANGE_TOKENS, board.key
        if offered:
            assert board.body["default_range"] in offered, board.key


def test_a_board_without_time_ranges_draws_no_time_bucket() -> None:
    """Without a range the portal runs a widget over all rows, with no bucket column."""
    for board in cc.BOARDS:
        if "time_ranges" in board.body:
            continue
        bucketed = [w for w in board.widgets if "bucket" in _columns(_WIDGETS[w])]
        assert bucketed == [], f"{board.key} draws a bucket it never asks for"


def test_the_failing_widgets_are_drawn_and_the_failing_board_has_a_working_neighbour() -> None:
    failing = _board("failing_widget")

    assert set(_WIDGETS) >= cc.FAILING_WIDGETS
    assert set(failing.widgets) & cc.FAILING_WIDGETS
    assert set(failing.widgets) - cc.FAILING_WIDGETS


def test_the_failing_definitions_do_not_sort_first_in_their_lists() -> None:
    """The portal smoke tests open the first item of each list and fail on a server error."""
    failing_metrics = {_WIDGETS[w].body["metric"] for w in cc.FAILING_WIDGETS}
    for rows, failing in ((cc.METRICS, failing_metrics), (cc.WIDGETS, cc.FAILING_WIDGETS)):
        first = min(rows, key=lambda d: (d.name.casefold(), d.id))
        assert first.id not in failing, f"{first.id} sorts first"


@pytest.mark.parametrize(
    ("case", "predicate"),
    [
        ("a line", lambda w: w.body["type"] == "line"),
        ("an area", lambda w: w.body["type"] == "area"),
        (
            "a plain bar",
            lambda w: w.body["type"] == "bar" and not {"labels", "series"} & set(w.body),
        ),
        ("a bar with labels", lambda w: w.body.get("labels") is True),
        ("a stacked bar", lambda w: "series" in w.body),
        ("a pie", lambda w: w.body["type"] == "pie"),
        ("a stat", lambda w: w.body["type"] == "stat"),
        ("a table", lambda w: w.body["type"] == "table"),
    ],
)
def test_the_board_of_every_widget_type_draws(
    case: str, predicate: Callable[[cc.Definition], bool]
) -> None:
    every = _board("every_widget_type")
    assert any(predicate(_WIDGETS[w]) for w in every.widgets), f"no {case}"


def test_the_boards_cover_every_case_the_renderers_must_draw() -> None:
    def percent_columns(widget: cc.Definition) -> set[str]:
        metric = _METRICS[widget.body["metric"]]
        return {f["as_name"] for f in metric.body["fields"] if f.get("percent")} & set(
            _columns(widget)
        )

    def drawn(board: cc.Board) -> list[cc.Definition]:
        return [_WIDGETS[w] for w in board.widgets]

    cases = {
        "headings": lambda b: any("heading" in i for i in b.body["items"]),
        "texts with markdown characters": lambda b: any(
            "**" in i.get("text", "") for i in b.body["items"]
        ),
        "time ranges": lambda b: bool(b.body.get("time_ranges")),
        "no time ranges": lambda b: "time_ranges" not in b.body,
        "a clocked widget": lambda b: any(_clocked(_METRICS[w.body["metric"]]) for w in drawn(b)),
        "a clockless widget": lambda b: any(
            not _clocked(_METRICS[w.body["metric"]]) for w in drawn(b)
        ),
        "a percent stat": lambda b: any(
            w.body["type"] == "stat" and percent_columns(w) for w in drawn(b)
        ),
        "a percent column": lambda b: any(
            w.body["type"] == "table" and percent_columns(w) for w in drawn(b)
        ),
        "over 500 rows": lambda b: any(
            _METRICS[w.body["metric"]].body.get("limit", 0) > 500 for w in drawn(b)
        ),
        "every range": lambda b: "inf" in b.body.get("time_ranges", []),
        "15 or more widgets": lambda b: len(b.widgets) >= 15,
        "a folder": lambda b: b.in_folder,
        "sharing": lambda b: b.shared_with_ceo,
        "a star": lambda b: b.starred,
    }

    uncovered = [case for case, predicate in cases.items() if not _boards_where(predicate)]
    assert uncovered == []


def test_a_reseed_at_one_anchor_writes_the_same_rows_after_clearing_its_own() -> None:
    first = store.mariadb_rows(_ANCHOR)

    assert first == store.mariadb_rows(_ANCHOR)
    assert all(statement.startswith("DELETE") for statement, _ in first[: len(store._CLEAR)])
    assert not any(s.startswith("DELETE") for s, _ in first[len(store._CLEAR) :])


def test_the_dataset_records_end_at_the_anchor_and_repeat_exactly() -> None:
    records = cc.dataset_records(_ANCHOR)

    assert records == cc.dataset_records(_ANCHOR)
    assert max(r.at for r in records).startswith(_ANCHOR.isoformat())
    assert {r.team for r in records} == {"Atlas", "Borealis", "Cobalt", "Delta"}
