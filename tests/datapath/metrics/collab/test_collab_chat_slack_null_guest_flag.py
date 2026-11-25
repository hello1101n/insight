"""A Slack row with an unknown guest flag counts only when its member resolves.

Staging keeps the row and the analytics runtime resolves it at read time: by the
account binding first, then by the email. A member that resolves to no person
counts for nobody, and the connector check reports the row.
"""

from __future__ import annotations

import pytest
from insight_datapath import clickhouse
from insight_datapath.dbt_runner import DbtRunner
from insight_datapath.instance import InstanceConfig
from insight_datapath.spec_runner import SpecRun

pytestmark = pytest.mark.fixture

SPEC = "collab_chat_slack_null_guest_flag"

CHECK = "assert_slack_members_resolve"

MESSAGES = {
    "alice@example.com": 3,
    "judy@example.com": 55,
    "dave@example.com": 8,
    "carol@example.com": None,
}


def test_a_null_guest_flag_counts_only_for_a_resolved_member(spec: SpecRun) -> None:
    """judy resolves by her email, dave by the operator binding; carol resolves to nobody."""
    r = spec.call(
        {
            "url": "/v1/metric-results",
            "method": "POST",
            "body": {
                "entity": {"type": "person", "ids": list(MESSAGES)},
                "period": {"from": "2026-12-01", "to": "2026-12-31"},
                "metrics": [{"metric_key": "collab.messages_sent", "views": [{"view": "period"}]}],
            },
        }
    )
    assert r.status == 200

    for email, messages in MESSAGES.items():
        r.row("collab.messages_sent", "period", entity_id=email).equals(value=messages)


def test_the_check_reports_only_the_unresolved_member(
    spec: SpecRun, dbt_runner: DbtRunner, instance_cfg: InstanceConfig
) -> None:
    """The connector check lists carol's row and no row of a resolved member."""
    dbt_runner.build(CHECK)

    rows = clickhouse.query(
        instance_cfg,
        f"SELECT unique_key FROM dbt_test__audit.{CHECK} WHERE problem = 'unresolved_null_guest'",
    )

    assert sorted(row[0] for row in rows) == ["sln-carol-20261220"]
