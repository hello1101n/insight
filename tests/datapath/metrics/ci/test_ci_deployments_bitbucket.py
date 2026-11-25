"""Bitbucket deployments created, with the outcome folded from the latest state, at tenant grain.

Bronze: Bitbucket deployments, one row per deployment holding its latest state and its
environment's name and type. Silver keeps the deployment and one event per state version a
sync observed, and leaves out a deployment still UNDEPLOYED: a placeholder for a manual step
that has not run. Gold takes the latest event as outcome; the environment type Production is
the production split and every other type is static.
"""

from __future__ import annotations

import pytest
from insight_datapath.metric_expect import approx, one, some
from insight_datapath.spec_runner import SpecRun

pytestmark = pytest.mark.fixture

SPEC = "ci_deployments_bitbucket"


def _deployments(views: list[dict]) -> dict:
    return {
        "url": "/v1/metric-results",
        "method": "POST",
        "body": {
            "entity": {"type": "tenant"},
            "period": {"from": "2026-03-01", "to": "2026-03-07"},
            "metrics": [{"metric_key": "ci.deployments", "views": views}],
        },
    }


def test_the_placeholder_is_skipped_and_every_state_maps_to_an_outcome(spec: SpecRun) -> None:
    """Four deployments: the duplicate counts once, the UNDEPLOYED placeholder is not a
    pending deployment, and success, failure, in_progress and cancelled count one each."""
    r = spec.call(
        _deployments(
            [
                {"view": "period"},
                {"view": "breakdown", "dimensions": ["outcome"]},
                {"view": "timeseries", "bucket": "day"},
            ]
        )
    )
    assert r.status == 200

    r.row("ci.deployments", "period", entity_id=spec.tenant).equals(value=4.0)
    by_outcome = r.breakdown("ci.deployments")
    for outcome in ("success", "failure", "in_progress", "cancelled"):
        bucket = one(by_outcome, dimensions={"key": "outcome", "value": outcome})
        assert float(bucket["value"]) == approx(1.0), outcome
    assert not some(by_outcome, dimensions={"key": "outcome", "value": "pending"})
    assert any(
        some(s["points"], bucket_start="2026-03-04", value=1.0) for s in r.series("ci.deployments")
    )


def test_the_environment_type_splits_production_from_the_rest(spec: SpecRun) -> None:
    """Production-typed environments are production; Staging and Test are static."""
    r = spec.call(_deployments([{"view": "breakdown", "dimensions": ["env_kind"]}]))
    assert r.status == 200

    by_env_kind = r.breakdown("ci.deployments")
    for env_kind in ("production", "static"):
        bucket = one(by_env_kind, dimensions={"key": "env_kind", "value": env_kind})
        assert float(bucket["value"]) == approx(2.0), env_kind
    assert not some(by_env_kind, dimensions={"key": "env_kind", "value": "preview"})


def test_the_environment_name_is_the_environment_dimension(spec: SpecRun) -> None:
    """The embedded environment's name labels each deployment."""
    r = spec.call(_deployments([{"view": "breakdown", "dimensions": ["environment"]}]))
    assert r.status == 200

    by_environment = r.breakdown("ci.deployments")
    for environment, deployments in (("Production", 2.0), ("Staging", 1.0), ("Test", 1.0)):
        bucket = one(by_environment, dimensions={"key": "environment", "value": environment})
        assert float(bucket["value"]) == approx(deployments), environment
