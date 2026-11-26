"""`/api/v3` — the deployed service reads and runs every seeded custom dashboard.

    GET  /v1/dashboards/{id}                          200 for the owner
    GET  /v1/dashboards/{id}/widgets                  200, the widgets the manifest names, with
                                                      the percent and duration columns of each
    POST /v1/dashboards/{id}/widgets/{widget}/run     200, or a failure for a widget that fails on purpose
    POST /v1/dashboards/{id}/widgets/{widget}/drilldown
                                                      200, each row of a detail metric linked to
                                                      its record in the source system
    GET  /v1/dashboards                               the CEO sees the shared board and no other
    GET  /v1/pins, GET /v1/folders                    the starred board and the folder read back

The seed writes the custom catalogue as rows, not through this API, because the
API takes only a person's session and mints its own ids. So nothing validates a
seeded definition when it is written. These tests are that validation: each
board must read back through the deployed gateway, list the widgets the manifest
names, and run every widget. A definition the service cannot read or run fails
here, before a renderer test or a person opens the board.

No test asserts a metric value. A run proves only that the service compiled the
metric and that ClickHouse answered it.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from insight_stand import ApiClient, CustomBoard, Manifest, PersonaSession, v3_path
from pydantic import BaseModel, JsonValue

pytestmark = [pytest.mark.requires_custom_catalogue, pytest.mark.requires_seed("admin_operator")]

BUCKET = "bucket"

#: The base URL that the compose stand gives the seeded git source, in
#: `x-external-sources` of docker-compose.yml.
SOURCE_BASE_URL = "https://git.example.com/"

#: The keys that name a metric column, per widget type, as the portal reads them.
COLUMN_KEYS: dict[str, tuple[str, ...]] = {
    "line": ("x", "y"),
    "area": ("x", "y"),
    "bar": ("x", "y", "series"),
    "pie": ("label", "value"),
    "stat": ("value",),
    "table": (),
    "heatmap": ("x", "y", "value"),
    "funnel": (),
    "treemap": ("label", "value", "group"),
    "scatter": ("x", "y", "size", "series", "label"),
}


class DashboardRead(BaseModel):
    id: str
    name: str
    body: dict[str, JsonValue]


class DrawnWidget(BaseModel):
    id: str
    name: str
    body: dict[str, JsonValue]
    clock: dict[str, JsonValue] | None = None
    percents: list[str] = []
    units: dict[str, str] = {}


class DashboardWidgets(BaseModel):
    items: list[DrawnWidget]


class RunResult(BaseModel):
    columns: list[str]
    rows: list[list[JsonValue]]


class DrilldownRow(BaseModel):
    values: dict[str, JsonValue]
    link: str | None = None


class DrilldownPage(BaseModel):
    rows: list[DrilldownRow]


class Listed(BaseModel):
    id: str
    name: str


class Listing(BaseModel):
    items: list[Listed]


class Pins(BaseModel):
    pins: list[Listed]


class FolderSummary(BaseModel):
    id: str
    name: str
    dashboards: int


class Folders(BaseModel):
    folders: list[FolderSummary]


def _boards(manifest: Manifest) -> list[CustomBoard]:
    assert manifest.custom_catalogue is not None, "the manifest declares no custom catalogue"
    boards = list(manifest.custom_catalogue.dashboards.values())
    assert boards, "the manifest names no seeded dashboard; every test below would pass vacuously"
    return boards


def _drawn(client: ApiClient, board: CustomBoard) -> list[DrawnWidget]:
    response = client.get(v3_path(f"/v1/dashboards/{board.id}/widgets"))
    assert response.status_code == 200, f"{board.key}: {response.status_code} {response.text[:300]}"
    return response.parse(DashboardWidgets).items


def _run_options(board: DashboardRead, widget: DrawnWidget) -> dict[str, JsonValue]:
    """The run body the portal sends: the board's default range, for a clocked widget only."""
    ranges = board.body.get("time_ranges")
    if not ranges or widget.clock is None:
        return {}
    assert isinstance(ranges, list)
    default = board.body.get("default_range") or ranges[0]
    kind = widget.body.get("type")
    assert isinstance(kind, str), f"{widget.id}: no widget type"
    columns = [widget.body.get(key) for key in COLUMN_KEYS[kind]]
    listed = widget.body.get("columns")
    if isinstance(listed, list):
        columns += listed
    return {"range": default, "bucket": BUCKET in columns}


@pytest.mark.reliability
def test_every_seeded_board_lists_the_widgets_the_manifest_names(
    admin_operator_session: PersonaSession, stand_manifest: Manifest
) -> None:
    client = admin_operator_session.client
    mismatches = []
    for board in _boards(stand_manifest):
        read = client.get(v3_path(f"/v1/dashboards/{board.id}"))
        if read.status_code != 200:
            mismatches.append(f"{board.key}: GET answered {read.status_code} {read.text[:200]}")
            continue
        assert read.parse(DashboardRead).name == board.name, f"{board.key}: another name"

        drawn = {(widget.id, widget.name) for widget in _drawn(client, board)}
        expected = {(widget.id, widget.name) for widget in board.widgets}
        if drawn != expected:
            mismatches.append(
                f"{board.key}: drew {sorted(drawn)}, manifest names {sorted(expected)}"
            )

    assert not mismatches, "\n".join(mismatches)


@pytest.mark.reliability
def test_every_seeded_widget_lists_the_percent_and_duration_columns_its_metric_declares(
    admin_operator_session: PersonaSession, stand_manifest: Manifest
) -> None:
    client = admin_operator_session.client
    boards = _boards(stand_manifest)
    seeded = {widget.id: widget for board in boards for widget in board.widgets}
    if any(widget.percents is None or widget.units is None for widget in seeded.values()):
        pytest.skip("the manifest predates the widget formats; re-seed the stand")
    assert any(widget.units for widget in seeded.values()), (
        "the seed declares no duration column; the check would pass vacuously"
    )
    assert any(widget.percents for widget in seeded.values()), (
        "the seed declares no percent column; the check would pass vacuously"
    )

    wrong = []
    for board in boards:
        for listed in _drawn(client, board):
            declared = seeded[listed.id]
            listed_formats = (set(listed.percents), listed.units)
            declared_formats = (set(declared.percents or ()), dict(declared.units or {}))
            if listed_formats != declared_formats:
                wrong.append(
                    f"{board.key}/{listed.id}: lists {listed_formats}, the seed declares "
                    f"{declared_formats}"
                )

    assert not wrong, "\n".join(wrong)


@pytest.mark.reliability
def test_every_seeded_widget_runs_except_the_ones_that_fail_on_purpose(
    admin_operator_session: PersonaSession, stand_manifest: Manifest
) -> None:
    client = admin_operator_session.client
    wrong = []
    failing_seen = 0
    for board in _boards(stand_manifest):
        read = client.get(v3_path(f"/v1/dashboards/{board.id}")).parse(DashboardRead)
        for widget in _drawn(client, board):
            path = v3_path(f"/v1/dashboards/{board.id}/widgets/{widget.id}/run")
            response = client.post(path, json_body=_run_options(read, widget))
            if widget.id in board.failing_widgets:
                failing_seen += 1
                if response.status_code < 400:
                    wrong.append(
                        f"{board.key}/{widget.id}: should fail, answered {response.status_code}"
                    )
                continue
            if response.status_code != 200:
                wrong.append(
                    f"{board.key}/{widget.id}: {response.status_code} {response.text[:200]}"
                )
                continue
            if not response.parse(RunResult).columns:
                wrong.append(f"{board.key}/{widget.id}: the run named no column")

    assert not wrong, "\n".join(wrong)
    assert failing_seen, "no seeded widget fails on purpose, so the failure path went unchecked"


@pytest.mark.reliability
def test_each_record_behind_a_detail_drilldown_links_to_the_source_system(
    admin_operator_session: PersonaSession, stand_manifest: Manifest
) -> None:
    """A row that reads one commit or pull request carries the URL of that record."""
    client = admin_operator_session.client
    board = stand_manifest.custom_board("every_widget_type")
    detailed = [widget for widget in _drawn(client, board) if "detail" in widget.body]
    assert detailed, "no seeded widget names a detail metric, so the check would pass vacuously"

    wrong = []
    for widget in detailed:
        path = v3_path(f"/v1/dashboards/{board.id}/widgets/{widget.id}/drilldown")
        response = client.post(path, json_body={"limit": 50})
        if response.status_code != 200:
            wrong.append(f"{widget.id}: {response.status_code} {response.text[:200]}")
            continue
        rows = response.parse(DrilldownPage).rows
        if not rows:
            wrong.append(f"{widget.id}: the drilldown answered no row")
        unlinked = [row for row in rows if not (row.link or "").startswith(SOURCE_BASE_URL)]
        if unlinked:
            wrong.append(
                f"{widget.id}: {len(unlinked)} of {len(rows)} rows link elsewhere or nowhere, "
                f"first {unlinked[0].link!r} for {unlinked[0].values}"
            )

    assert not wrong, "\n".join(wrong)


@pytest.mark.security
@pytest.mark.requires_seed("ceo")
def test_the_ceo_sees_the_shared_board_and_no_other_seeded_board(
    session_for: Callable[[str], PersonaSession], stand_manifest: Manifest
) -> None:
    shared = stand_manifest.custom_board("shared")
    seeded = {board.id for board in _boards(stand_manifest)}

    response = session_for("ceo").client.get(v3_path("/v1/dashboards"), params={"limit": 200})
    assert response.status_code == 200, f"{response.status_code} {response.text[:300]}"

    visible = {item.id for item in response.parse(Listing).items} & seeded
    assert visible == {shared.id}, f"the CEO sees {sorted(visible)}, not only {shared.id}"


@pytest.mark.reliability
def test_the_starred_board_and_the_folder_read_back_for_their_owner(
    admin_operator_session: PersonaSession, stand_manifest: Manifest
) -> None:
    assert stand_manifest.custom_catalogue is not None
    client = admin_operator_session.client

    pins = client.get(v3_path("/v1/pins"))
    assert pins.status_code == 200, f"{pins.status_code} {pins.text[:300]}"
    starred = stand_manifest.custom_board("starred").id
    assert starred in {pin.id for pin in pins.parse(Pins).pins}, f"{starred} is not starred"

    folders = client.get(v3_path("/v1/folders"))
    assert folders.status_code == 200, f"{folders.status_code} {folders.text[:300]}"
    named = [
        f
        for f in folders.parse(Folders).folders
        if f.name == stand_manifest.custom_catalogue.folder
    ]
    assert len(named) == 1, (
        f"expected one folder {stand_manifest.custom_catalogue.folder!r}, got {named}"
    )

    filed = client.get(v3_path("/v1/dashboards"), params={"folder": named[0].id})
    assert filed.status_code == 200, f"{filed.status_code} {filed.text[:300]}"
    in_folder = stand_manifest.custom_board("in_folder").id
    assert [item.id for item in filed.parse(Listing).items] == [in_folder]


@pytest.mark.security
def test_an_unauthenticated_caller_never_reaches_any_of_this(
    api_client: ApiClient, stand_manifest: Manifest
) -> None:
    board = stand_manifest.custom_board("every_widget_type")
    response = api_client.get(v3_path(f"/v1/dashboards/{board.id}"))
    assert response.status_code == 401, f"{response.status_code} {response.text[:300]}"
