"""`custom_catalogue` — the dashboards, widgets and dataset the seed wrote.

Optional on the manifest. A stand without the catalogue reports it as None, and
a test that needs a board carries `requires_custom_catalogue`, so it skips on
the capability before it reads anything here.

A test names a board by its key (`every_widget_type`, `failing_widget`, ...),
never by its id or name. The keys are a contract like the fixture names: each
key says what the board tests.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .errors import ManifestError


def _text(doc: Mapping[str, Any], key: str, where: str) -> str:
    value = doc.get(key)
    if not isinstance(value, str):
        raise ManifestError(f"{where}: field {key!r} must be str, got {type(value).__name__}")
    return value


def _objects(doc: Mapping[str, Any], key: str, where: str) -> list[Mapping[str, Any]]:
    value = doc.get(key)
    if not isinstance(value, list) or not all(isinstance(entry, Mapping) for entry in value):
        raise ManifestError(f"{where}: field {key!r} must be a list of objects")
    return value


def _percents(doc: Mapping[str, Any], where: str) -> frozenset[str] | None:
    value = doc.get("percents")
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(name, str) for name in value):
        raise ManifestError(f"{where}: field 'percents' must be a list of strings")
    return frozenset(value)


def _units(doc: Mapping[str, Any], where: str) -> Mapping[str, str] | None:
    value = doc.get("units")
    if value is None:
        return None
    if not isinstance(value, Mapping) or not all(
        isinstance(name, str) and isinstance(unit, str) for name, unit in value.items()
    ):
        raise ManifestError(f"{where}: field 'units' must map column names to units")
    return dict(value)


@dataclass(frozen=True)
class CustomWidget:
    """One seeded widget, and the percent and duration columns of its metric.

    `percents` and `units` are None in a manifest written before they existed.
    """

    id: str
    name: str
    percents: frozenset[str] | None
    units: Mapping[str, str] | None


@dataclass(frozen=True)
class CustomBoard:
    """One seeded dashboard: where it is, what it draws, and which cells fail."""

    key: str
    id: str
    name: str
    path: str
    covers: str
    widgets: tuple[CustomWidget, ...]
    failing_widgets: frozenset[str]

    @classmethod
    def parse(cls, key: str, doc: Mapping[str, Any], where: str) -> CustomBoard:
        widgets = tuple(
            CustomWidget(
                id=_text(entry, "id", where),
                name=_text(entry, "name", where),
                percents=_percents(entry, where),
                units=_units(entry, where),
            )
            for entry in _objects(doc, "widgets", where)
        )
        failing = doc.get("failing_widgets")
        if not isinstance(failing, list) or not all(isinstance(w, str) for w in failing):
            raise ManifestError(f"{where}: field 'failing_widgets' must be a list of strings")
        unknown = set(failing) - {widget.id for widget in widgets}
        if unknown:
            raise ManifestError(
                f"{where}: failing_widgets names widgets the board lacks: {unknown}"
            )
        return cls(
            key=key,
            id=_text(doc, "id", where),
            name=_text(doc, "name", where),
            path=_text(doc, "path", where),
            covers=_text(doc, "covers", where),
            widgets=widgets,
            failing_widgets=frozenset(failing),
        )

    @property
    def working_widgets(self) -> tuple[CustomWidget, ...]:
        return tuple(widget for widget in self.widgets if widget.id not in self.failing_widgets)


@dataclass(frozen=True)
class CustomCatalogue:
    dashboards: Mapping[str, CustomBoard]
    dataset: str
    folder: str

    @classmethod
    def parse(cls, doc: Mapping[str, Any], where: str) -> CustomCatalogue:
        boards = doc.get("dashboards")
        if not isinstance(boards, Mapping):
            raise ManifestError(f"{where}: field 'dashboards' must be an object")
        dashboards = {}
        for key, entry in boards.items():
            if not isinstance(entry, Mapping):
                raise ManifestError(f"{where}.dashboards[{key!r}]: must be an object")
            dashboards[key] = CustomBoard.parse(key, entry, f"{where}.dashboards[{key!r}]")
        return cls(
            dashboards=dashboards,
            dataset=_text(doc, "dataset", where),
            folder=_text(doc, "folder", where),
        )

    def board(self, key: str) -> CustomBoard:
        """Resolve one board by its key, or fail naming the keys there are."""
        try:
            return self.dashboards[key]
        except KeyError:
            available = ", ".join(sorted(self.dashboards)) or "<none>"
            raise ManifestError(f"no seeded dashboard {key!r}; available: {available}") from None


__all__: Sequence[str] = ("CustomBoard", "CustomCatalogue", "CustomWidget")
