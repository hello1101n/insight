from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from disposable import prepare  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def disposable_warehouse(tmp_path_factory: pytest.TempPathFactory) -> None:
    prepare(("chatgpt-team",), tmp_path_factory.mktemp("profile"))
