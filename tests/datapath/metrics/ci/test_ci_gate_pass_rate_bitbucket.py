"""Share of commit-triggered Bitbucket Pipelines runs that passed, served at tenant grain.

Bronze: Bitbucket pipelines, one row per pipeline holding its latest run. Silver keeps
each run attempt, maps a push that built a pull request to the pull_request trigger,
counts a run paused on a manual step as passed and an expired run as timed out, and
leaves a halted or pending run undecided. Gold counts a rerun pipeline once at its last
attempt, dated at that attempt's start; pass rate is passed gate runs over gate runs.
"""

from __future__ import annotations

import pytest
from insight_datapath.metric_expect import approx, one, some
from insight_datapath.spec_runner import SpecRun

pytestmark = pytest.mark.fixture

SPEC = "ci_gate_pass_rate_bitbucket"

WEEK = {"from": "2026-03-01", "to": "2026-03-07"}


def _request(metric_key: str, views: list[dict]) -> dict:
    return {
        "url": "/v1/metric-results",
        "method": "POST",
        "body": {
            "entity": {"type": "tenant"},
            "period": WEEK,
            "metrics": [{"metric_key": metric_key, "views": views}],
        },
    }


def test_gate_counts_pull_request_paused_and_rerun_runs(spec: SpecRun) -> None:
    """Eight gate runs, five passed: the pull-request run, the paused run and the rerun's
    passing last attempt pass; the error and the expired run fail; the duplicate counts once."""
    r = spec.call(
        _request(
            "ci.gate_pass_rate",
            [{"view": "period"}, {"view": "breakdown", "dimensions": ["pipeline"]}],
        )
    )
    assert r.status == 200

    r.row("ci.gate_pass_rate", "period", entity_id=spec.tenant).equals(value=62.5)
    by_pipeline = r.breakdown("ci.gate_pass_rate")
    for pipeline, rate in (
        ("branches:main", 50.0),
        ("pull-requests:**", 100.0),
        ("tags:v*", 100.0),
    ):
        bucket = one(by_pipeline, dimensions={"key": "pipeline", "value": pipeline})
        assert float(bucket["value"]) == approx(rate), pipeline


def test_runs_split_by_trigger_and_date_a_rerun_at_its_last_start(spec: SpecRun) -> None:
    """Twelve decided runs: a push building a pull request is pull_request, manual and
    on-demand runs are manual, halted and pending runs appear nowhere, and the rerun
    lands on Mar 02, the start of its last attempt."""
    r = spec.call(
        _request(
            "ci.runs",
            [
                {"view": "period"},
                {"view": "breakdown", "dimensions": ["trigger"]},
                {"view": "timeseries", "bucket": "day"},
            ],
        )
    )
    assert r.status == 200

    r.row("ci.runs", "period", entity_id=spec.tenant).equals(value=12.0)
    by_trigger = r.breakdown("ci.runs")
    for trigger, runs in (("push", 8.0), ("pull_request", 1.0), ("schedule", 1.0), ("manual", 2.0)):
        bucket = one(by_trigger, dimensions={"key": "trigger", "value": trigger})
        assert float(bucket["value"]) == approx(runs), trigger
    daily = [s["points"] for s in r.series("ci.runs")]
    assert any(
        some(points, bucket_start="2026-03-01", value=11.0)
        and some(points, bucket_start="2026-03-02", value=1.0)
        for points in daily
    )


def test_a_rerun_is_a_retry_and_not_a_first_try_pass(spec: SpecRun) -> None:
    """The rerun is the one retried gate run of eight; four of the five passes came on
    the first attempt."""
    retries = spec.call(_request("ci.gate_retry_share", [{"view": "period"}]))
    first_try = spec.call(_request("ci.gate_first_try_pass_rate", [{"view": "period"}]))
    assert retries.status == 200
    assert first_try.status == 200

    retries.row("ci.gate_retry_share", "period", entity_id=spec.tenant).equals(value=12.5)
    first_try.row("ci.gate_first_try_pass_rate", "period", entity_id=spec.tenant).equals(value=50.0)
