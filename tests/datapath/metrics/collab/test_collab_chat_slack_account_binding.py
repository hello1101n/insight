"""Slack chat rows resolve by the Slack account, so an email change keeps one person.

Each chat row carries the account (slack, source, user_id). The email of the account
binds it to a person once; later rows under another email stay with that person.
An account without an email counts only after an operator binds it.
"""

from __future__ import annotations

import pytest
from insight_datapath.metric_expect import MetricResponse
from insight_datapath.spec_runner import SpecRun

pytestmark = [pytest.mark.fixture, pytest.mark.shared_dataset]

SPEC = "collab_chat_slack_account_binding"

ALICE = "alice@example.com"
BOB = "bob@example.com"
CAROL = "carol@example.com"

PERIOD = {"from": "2026-12-01", "to": "2026-12-31"}


def _messages_sent(spec: SpecRun, emails: list[str]) -> MetricResponse:
    r = spec.call(
        {
            "url": "/v1/metric-results",
            "method": "POST",
            "body": {
                "entity": {"type": "person", "ids": emails},
                "period": PERIOD,
                "metrics": [{"metric_key": "collab.messages_sent", "views": [{"view": "period"}]}],
            },
        }
    )
    assert r.status == 200
    return r


def test_email_change_keeps_the_history_under_one_person(spec: SpecRun) -> None:
    """alice's day under her previous email counts for her with the day under her current email."""
    r = _messages_sent(spec, [ALICE])

    r.row("collab.messages_sent", "period", entity_id=ALICE).equals(value=7)


def test_account_without_email_counts_once_bound(spec: SpecRun) -> None:
    """bob's account has no email; the operator binding attributes it. carol's is never bound."""
    r = _messages_sent(spec, [BOB, CAROL])

    r.row("collab.messages_sent", "period", entity_id=BOB).equals(value=5)
    r.row("collab.messages_sent", "period", entity_id=CAROL).equals(value=None)
