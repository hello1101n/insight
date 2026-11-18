"""Slack on Free and Pro: message history gives the same chat metrics as the analytics file.

Each message a member wrote counts once on its UTC day. Channel and private channel
messages are channel posts; DMs and group DMs are direct messages. Joins, bot
messages, guests and bots never count.
"""

from __future__ import annotations

import pytest
from insight_datapath.metric_expect import approx
from insight_datapath.spec_runner import SpecRun

pytestmark = [pytest.mark.fixture, pytest.mark.shared_dataset]

SPEC = "collab_chat_slack_message_history"

ALICE = "alice@example.com"
BOB = "bob@example.com"
CAROL = "carol@example.com"


@pytest.mark.parametrize(
    ("person", "metric_key", "expected"),
    [
        pytest.param(
            ALICE,
            "collab.messages_sent",
            4,
            id="member-messages-count-without-joins-or-bot-messages",
        ),
        pytest.param(
            ALICE,
            "collab.channel_posts",
            3,
            id="channel-and-private-channel-messages-are-channel-posts",
        ),
        pytest.param(ALICE, "collab.dm_ratio", 25, id="dms-over-all-messages"),
        pytest.param(BOB, "collab.messages_sent", None, id="a-guest-is-excluded"),
        pytest.param(CAROL, "collab.messages_sent", None, id="a-bot-is-excluded"),
    ],
)
def test_slack_message_history_metrics(
    spec: SpecRun, person: str, metric_key: str, expected: float | None
) -> None:
    r = spec.call(
        {
            "url": "/v1/metric-results",
            "method": "POST",
            "body": {
                "entity": {"type": "person", "ids": [person]},
                "period": {"from": "2026-12-01", "to": "2026-12-31"},
                "metrics": [{"metric_key": metric_key, "views": [{"view": "period"}]}],
            },
        }
    )
    assert r.status == 200, f"should answer 200 for {person} {metric_key}"
    row = r.row(metric_key, "period", entity_id=person)
    if expected is None:
        row.equals(value=None)
        return
    row.check(
        "value",
        lambda v: v is not None and float(v) == approx(expected),
        f"{metric_key} for {person} should be {expected}",
    )
