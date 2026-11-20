"""Slack bots never reach chat metrics.

The Slack chat feeder drops an account that the members list flags as a bot, and
always drops Slackbot (USLACKBOT).
"""

from __future__ import annotations

import pytest
from insight_datapath.spec_runner import SpecRun

pytestmark = [pytest.mark.fixture, pytest.mark.shared_dataset]

SPEC = "collab_chat_slack_bot_excluded"

MEMBER_MESSAGES = {"alice@example.com": 3}
BOTS = ["bob@example.com", "carol@example.com"]


def test_slack_bots_are_excluded_and_members_count(spec: SpecRun) -> None:
    """A member serves its message count; a bot and Slackbot serve null."""
    r = spec.call(
        {
            "url": "/v1/metric-results",
            "method": "POST",
            "body": {
                "entity": {"type": "person", "ids": [*MEMBER_MESSAGES, *BOTS]},
                "period": {"from": "2026-12-01", "to": "2026-12-31"},
                "metrics": [{"metric_key": "collab.messages_sent", "views": [{"view": "period"}]}],
            },
        }
    )
    assert r.status == 200

    for email, messages in MEMBER_MESSAGES.items():
        r.row("collab.messages_sent", "period", entity_id=email).equals(value=messages)
    for email in BOTS:
        r.row("collab.messages_sent", "period", entity_id=email).equals(value=None)
