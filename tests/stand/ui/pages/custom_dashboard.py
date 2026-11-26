"""A custom dashboard at `/dashboards/<id>`, in either renderer.

The current renderer draws each widget as a card with a menu button named
`More for <widget>`. The FrontX renderer draws each widget as a cell: a `group`
named after the widget, with a `Details` button for an administrator.
"Show planned sections" in the rail's Settings picks the renderer.
"""

from __future__ import annotations

import re

from playwright.sync_api import Locator, Page

from ..steps import step
from .portal_shell import RAIL

# INVARIANT: these are the cannot-be-shown texts that frontx-board.tsx gives FrontX, one per failure kind.
CELL_FAILURE = re.compile(
    r"^(This widget couldn't be loaded\.|The metric could not be run\.|Couldn't draw this widget\.)$"
)


class CustomDashboardPage:
    def __init__(self, page: Page) -> None:
        self.page = page
        self.settings = page.locator(RAIL).get_by_role("button", name="Settings", exact=True)
        self.planned_sections = page.get_by_role("button", name="Show planned sections", exact=True)

    def go(self, path: str) -> None:
        with step(f"Open the dashboard at {path}"):
            self.page.goto(path)

    def open_settings(self) -> None:
        with step("Open Settings in the rail"):
            self.settings.click()

    def toggle_planned_sections(self) -> None:
        with step('Switch "Show planned sections"'):
            self.planned_sections.click()

    def close_settings(self) -> None:
        with step("Close Settings"):
            self.page.keyboard.press("Escape")

    def turn_on_planned_sections(self) -> None:
        """For a page that starts with the setting off, as a new reader does."""
        self.open_settings()
        self.toggle_planned_sections()
        self.close_settings()

    def card_menu(self, widget: str) -> Locator:
        return self.page.get_by_role("button", name=f"More for {widget}", exact=True)

    def cell(self, widget: str) -> Locator:
        return self.page.get_by_role("group", name=widget, exact=True)

    def details(self, widget: str) -> Locator:
        return self.cell(widget).get_by_role("button", name="Details", exact=True)

    def cell_failure(self, widget: str) -> Locator:
        return self.cell(widget).get_by_text(CELL_FAILURE)

    def drilldown(self, widget: str) -> Locator:
        return self.page.get_by_role("dialog", name=widget)

    def drilldown_rows(self, widget: str) -> Locator:
        return self.drilldown(widget).get_by_role("table").get_by_role("row")
