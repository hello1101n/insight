"""A data-quality check of tier `warn` declares `severity='warn'`.

dbt reads only `severity`: without it a check is an error, a failure makes
`dbt test` exit non-zero, and the run alert fires for a check the tier calls a
warning.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

INGESTION = Path(__file__).resolve().parents[2]

WARN_TIER = re.compile(r"""['"]tier['"]\s*:\s*['"]warn['"]""")
WARN_SEVERITY = re.compile(r"""\bseverity\s*=\s*['"]warn['"]""")


def warn_tier_checks() -> list[Path]:
    return sorted(p for p in INGESTION.rglob("*.sql") if WARN_TIER.search(p.read_text(encoding="utf-8")))


def test_the_scan_finds_warn_tier_checks() -> None:
    assert warn_tier_checks(), "should find at least one check with tier 'warn'"


@pytest.mark.parametrize("check", warn_tier_checks(), ids=lambda p: p.name)
def test_a_warn_tier_check_declares_warn_severity(check: Path) -> None:
    assert WARN_SEVERITY.search(check.read_text(encoding="utf-8")), (
        f"should declare severity='warn': {check.relative_to(INGESTION)}"
    )
