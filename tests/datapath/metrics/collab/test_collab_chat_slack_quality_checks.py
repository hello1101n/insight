"""The Slack connector checks report a real data problem and pass clean data.

`assert_slack_bronze_rows_reach_metrics` has the tier error, so each of its findings
raises an alert. `assert_slack_members_resolve` has the tier warn: an unmapped member
is a task for identity resolution, not a broken sync.
"""

from __future__ import annotations

import pytest
from insight_datapath import clickhouse
from insight_datapath.dbt_runner import DbtRunner
from insight_datapath.instance import InstanceConfig
from insight_datapath.spec_runner import SpecRun

pytestmark = pytest.mark.fixture

SPEC = "collab_chat_slack_quality_checks"

ROWS_CHECK = "assert_slack_bronze_rows_reach_metrics"
MEMBERS_CHECK = "assert_slack_members_resolve"


def test_the_rows_check_reports_only_dropped_member_rows(
    spec: SpecRun, dbt_runner: DbtRunner, instance_cfg: InstanceConfig
) -> None:
    """The blank row and frank's row are reported; the guest and the bot rows are not."""
    dbt_runner.build(ROWS_CHECK)

    rows = clickhouse.query(
        instance_cfg,
        f"SELECT problem, unique_key FROM dbt_test__audit.{ROWS_CHECK} ORDER BY problem",
    )

    assert [(row[0], row[1]) for row in rows] == [
        ("missing_counter", "slq-frank-20261220"),
        ("refused_day_row", "slq-blank-20261220"),
    ]


def test_the_members_check_reports_one_finding_for_each_unbound_member(
    spec: SpecRun, dbt_runner: DbtRunner, instance_cfg: InstanceConfig
) -> None:
    """erin has no binding; alice and dave are bound, the guest and the bot are not members."""
    dbt_runner.build(MEMBERS_CHECK)

    rows = clickhouse.query(
        instance_cfg,
        f"SELECT problem, user_id, days FROM dbt_test__audit.{MEMBERS_CHECK}",
    )

    assert [(row[0], row[1], row[2]) for row in rows] == [("unmapped_member", "U203", 2)]
