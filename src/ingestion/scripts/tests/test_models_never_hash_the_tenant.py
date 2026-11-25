"""No dbt model derives a tenant from a hash.

The identity seed and every analytics read match rows on the canonical tenant
UUID, the value `tenant_uuid()` stamps. A tenant built with `sipHash128` never
equals the session tenant, so its rows build and then match nobody.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

INGESTION = Path(__file__).resolve().parents[2]
MODEL_ROOTS = (INGESTION / "connectors", INGESTION / "dbt", INGESTION / "silver", INGESTION / "gold")

HASHED_TENANT = re.compile(r"sipHash128\s*\(\s*(?:(?:coalesce|ifNull)\s*\(\s*)?[a-z_.]*tenant", re.IGNORECASE)


def models() -> list[Path]:
    return sorted(
        path
        for root in MODEL_ROOTS
        for path in root.rglob("*.sql")
        if ".venv" not in path.parts and "target" not in path.parts
    )


def hashes_the_tenant(sql: str) -> bool:
    return bool(HASHED_TENANT.search(sql))


@pytest.mark.parametrize(
    ("sql", "expected"),
    [
        ("toUUID(UUIDNumToString(sipHash128(coalesce(tenant_id, '')))) AS insight_tenant_id", True),
        ("sipHash128(tenant_id)", True),
        ("{{ tenant_uuid('tenant_id') }} AS insight_tenant_id", False),
        ("toUUID(UUIDNumToString(sipHash128(coalesce(source_id, '')))) AS insight_source_id", False),
    ],
)
def test_the_detector_tells_a_hashed_tenant_from_a_hashed_source(sql: str, expected: bool) -> None:
    assert hashes_the_tenant(sql) is expected, f"should {'flag' if expected else 'pass'}: {sql!r}"


def test_no_model_hashes_the_tenant() -> None:
    offenders = [str(path.relative_to(INGESTION)) for path in models() if hashes_the_tenant(path.read_text())]

    assert offenders == [], f"derive the tenant with tenant_uuid(), not sipHash128: {offenders}"
