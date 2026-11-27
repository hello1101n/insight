"""A class waits for an arm that another pipeline builds (#127).

A connector pipeline builds its own staging and then walks `tag:<connector>+`.
A silver class on that walk can have an arm from a second connector whose
bronze is present but whose staging that pipeline never builds. The arm is
then absent for the whole run, so the class must wait instead of reading
itself.

Here HubSpot bronze exists, Zendesk bronze does not, and the run is the Zendesk
pipeline's second step.
"""

from __future__ import annotations

import pytest
from conftest import Warehouse

CLASSES = ("class_support_agents", "class_support_groups", "class_support_group_memberships")
OTHER_PIPELINE_ARMS = ("hubspot__support_agents", "hubspot__support_groups", "hubspot__support_group_memberships")
STAGING_SELECT = "tag:zendesk"
WALK_SELECT = "tag:zendesk+"


@pytest.fixture(scope="module")
def other_connector_bronze(fresh_install: Warehouse) -> Warehouse:
    fresh_install.execute("CREATE DATABASE IF NOT EXISTS bronze_hubspot")
    fresh_install.execute("CREATE TABLE IF NOT EXISTS bronze_hubspot.owners (id String) ENGINE = MergeTree ORDER BY id")
    return fresh_install


def test_a_class_waits_for_an_arm_this_run_does_not_build(other_connector_bronze: Warehouse) -> None:
    walk = other_connector_bronze.models(WALK_SELECT, exclude=STAGING_SELECT)
    assert set(CLASSES) <= walk, "the walk should reach the support classes"
    assert not set(OTHER_PIPELINE_ARMS) & walk, "the walk should not build the other connector's arms"

    unbuildable = other_connector_bronze.unbuildable_models(selected=walk)

    assert set(CLASSES) <= unbuildable, f"should wait: {sorted(set(CLASSES) - unbuildable)}"


def test_the_whole_project_still_counts_every_arm_as_built(other_connector_bronze: Warehouse) -> None:
    unbuildable = other_connector_bronze.unbuildable_models()
    assert not set(CLASSES) & unbuildable, "a run of every model builds the HubSpot arms first"


def test_the_pipeline_walk_completes(other_connector_bronze: Warehouse) -> None:
    for select, exclude in ((STAGING_SELECT, ""), (WALK_SELECT, STAGING_SELECT)):
        models = other_connector_bronze.models(select, exclude=exclude)
        unbuildable = other_connector_bronze.unbuildable_models(selected=models)
        excluded = set(exclude.split()) | unbuildable

        result = other_connector_bronze.dbt_run(select, excluded)

        assert result.returncode == 0, f"{select} failed:\n{result.stdout[-3000:]}"
