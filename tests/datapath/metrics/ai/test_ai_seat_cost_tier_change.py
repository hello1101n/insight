"""Claude Team seat cost for a seat whose tier changed after its billing period began.

The invoice's base lines bill every seat at the tier it held when the period began;
a later change reaches the invoice only as a proration, which prices nothing. Gold
therefore prices a seat by its last reading before the period began, and falls back
to the month's closing tier only for a seat with no reading before then.
"""

from __future__ import annotations

import pytest
from insight_datapath.metric_expect import Row
from insight_datapath.spec_runner import SpecRun

pytestmark = pytest.mark.fixture

SPEC = "ai_seat_cost_tier_change"

ALICE = "alice@example.com"
DAVE = "dave@example.com"
ERIN = "erin@example.com"


def _december_seat_cost(spec: SpecRun, person: str) -> Row:
    r = spec.call(
        {
            "url": "/v1/metric-results",
            "method": "POST",
            "body": {
                "entity": {"type": "person", "ids": [person]},
                "period": {"from": "2026-12-01", "to": "2026-12-12"},
                "metrics": [{"metric_key": "ai.seat_cost", "views": [{"view": "period"}]}],
            },
        }
    )
    assert r.status == 200
    return r.row("ai.seat_cost", "period", entity_id=person)


def test_seat_moved_off_its_tier_after_billing_keeps_the_billed_price(spec: SpecRun) -> None:
    """Premium when the period began, no tier and no ceiling by month end: still 25.00."""
    _december_seat_cost(spec, DAVE).equals(value=25.0)


def test_seat_upgraded_after_billing_is_priced_at_the_tier_it_was_billed_at(spec: SpecRun) -> None:
    """Standard when the period began, Premium by month end: 12.00, not 25.00."""
    _december_seat_cost(spec, ERIN).equals(value=12.0)


def test_seat_first_read_after_billing_is_priced_by_its_closing_tier(spec: SpecRun) -> None:
    """No reading before the period began, so the closing Standard tier prices it."""
    _december_seat_cost(spec, ALICE).equals(value=12.0)
