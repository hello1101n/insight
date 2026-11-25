"""Seeded custom dashboards drawn through FrontX after a person turns it on.

"Show planned sections" picks the renderer of `/dashboards/<id>`. With it off,
the current renderer draws the board. With it on, the FrontX dashboard template
draws it. Every journey here starts with the setting off and turns it on in the
rail's Settings, as a person does.

Why these are browser tests and not API tests, measured on a compose stand
against the seeded `every_widget_type` board as the admin operator. The setting
is a key in the browser's local storage, and the renderer choice happens in the
SPA, so no HTTP client can see it. With the key absent, the board drew 0
`[data-cell-frame]` cells, 0 `group`s named after a widget and 0 `Details`
buttons, and it fetched nothing under `/widgets/`. After one click on the
Settings toggle, its `aria-pressed` went from `false` to `true`, the board drew 8
card cells, one `group` per widget name, each with a `Details` button, and it
fetched `/widgets/widgets.json` and the 5 `widget.gts.json` files it lists.
The toggle sent no new run: FrontX answered its 8 cells from the 8 runs that
the current renderer had already made. So the API answers are the same in both
states, and only the drawn page shows which renderer ran.

The `Details` button is a client-side cell action for an administrator: the
admin operator saw it on 8 of 8 cells, and the CEO saw it on 0 of 2 cells of
the shared board. The drilldown it opens is a dialog the SPA holds in its own
state. A click sent one `POST …/drilldown` that answered 200, and the dialog,
named after the widget, drew a table of 20 rows. On the `failing_widget` board
the run of the failing widget answered 500. The text "This widget couldn't be
loaded." is the FrontX frame's own failure state, set by the host, and it
appeared once, inside the failing cell, while the other cell drew.

No journey asserts a metric value.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from insight_stand import Manifest
from playwright.sync_api import Page, expect

from .pages.custom_dashboard import CustomDashboardPage

pytestmark = [
    pytest.mark.reliability,
    pytest.mark.requires_custom_catalogue,
    pytest.mark.requires_seed("admin_operator"),
]


@pytest.fixture
def admin_dashboard(
    browser_page_with_planned_off_for: Callable[[str], Page],
) -> CustomDashboardPage:
    return CustomDashboardPage(browser_page_with_planned_off_for("admin_operator"))


def test_turning_on_planned_sections_draws_a_seeded_board_through_frontx(
    admin_dashboard: CustomDashboardPage, stand_manifest: Manifest
) -> None:
    board = stand_manifest.custom_board("every_widget_type")
    assert board.widgets, "the board names no widget; the journey would assert nothing"

    admin_dashboard.go(board.path)
    for widget in board.widgets:
        expect(admin_dashboard.card_menu(widget.name), "the current renderer").to_be_visible()
    for widget in board.widgets:
        expect(admin_dashboard.cell(widget.name)).to_have_count(0)

    admin_dashboard.open_settings()
    expect(admin_dashboard.planned_sections).to_have_attribute("aria-pressed", "false")
    admin_dashboard.toggle_planned_sections()
    expect(admin_dashboard.planned_sections).to_have_attribute("aria-pressed", "true")
    admin_dashboard.close_settings()

    for widget in board.widgets:
        expect(admin_dashboard.cell(widget.name), f"the FrontX cell of {widget.id}").to_be_visible()
        expect(admin_dashboard.card_menu(widget.name)).to_have_count(0)


def test_details_opens_the_drilldown_of_a_frontx_cell_for_an_admin(
    admin_dashboard: CustomDashboardPage, stand_manifest: Manifest
) -> None:
    board = stand_manifest.custom_board("every_widget_type")
    widget = board.widgets[0]

    admin_dashboard.go(board.path)
    admin_dashboard.turn_on_planned_sections()
    for drawn in board.widgets:
        expect(admin_dashboard.details(drawn.name), f"Details on {drawn.id}").to_be_visible()

    with admin_dashboard.page.expect_response(
        lambda response: response.url.endswith(f"/widgets/{widget.id}/drilldown")
    ) as drilldown:
        admin_dashboard.details(widget.name).click()

    assert drilldown.value.status == 200, f"the drilldown answered {drilldown.value.status}"
    expect(admin_dashboard.drilldown(widget.name)).to_be_visible()
    expect(admin_dashboard.drilldown_rows(widget.name).nth(1), "a drilldown row").to_be_visible()


def test_a_failing_frontx_cell_says_so_and_its_neighbour_still_draws(
    admin_dashboard: CustomDashboardPage, stand_manifest: Manifest
) -> None:
    board = stand_manifest.custom_board("failing_widget")
    failing = [w for w in board.widgets if w.id in board.failing_widgets]
    working = board.working_widgets
    assert failing, "the board names no failing widget; the journey would assert nothing"
    assert working, "the board names no working widget beside the failing one"

    admin_dashboard.go(board.path)
    admin_dashboard.turn_on_planned_sections()

    for widget in failing:
        expect(admin_dashboard.cell_failure(widget.name), f"{widget.id} fails").to_be_visible()
    for widget in working:
        expect(admin_dashboard.cell(widget.name), f"the cell of {widget.id}").to_be_visible()
        expect(admin_dashboard.cell(widget.name)).not_to_have_attribute("aria-busy", "true")
        expect(admin_dashboard.cell_failure(widget.name), f"{widget.id} draws").to_have_count(0)
