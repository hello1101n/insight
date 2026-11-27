"""The shape every seeded metric and widget shares, and the prefix of every id.

INVARIANT: every id starts with `ID_PREFIX`. The service gives a UUID to each
definition that its API creates, and a UUID never starts with `stand-`. So the
store replaces its own rows and never touches a row that it did not write.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Final

ID_PREFIX: Final = "stand-"

Body = dict[str, Any]


@dataclass(frozen=True)
class Definition:
    """A metric or a widget, stored as the service stores it."""

    id: str
    name: str
    body: Body
