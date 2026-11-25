"""The tenant cutover hooks run in the order the cutover needs, inside a 3h helm timeout.

Run: pytest charts/insight/tests
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest
import yaml

CHART = Path(__file__).resolve().parents[1]
TENANT = "00000000-0000-4000-8000-000000000001"
HELM_TIMEOUT_SECONDS = 3 * 3600
ENABLED = [
    "--set", "keycloakConfig.enabled=true",
    "--set", "keycloakConfig.url=https://kc.example.test",
    "--set", "clickhouse.fieldValueMap.enabled=true",
]  # fmt: skip


@pytest.fixture(scope="module")
def manifests() -> list[dict[str, Any]]:
    subprocess.run(["helm", "dependency", "build", str(CHART)], capture_output=True, timeout=300, check=False)
    return _render(ENABLED)


def _render(overrides: list[str]) -> list[dict[str, Any]]:
    result = subprocess.run(
        ["helm", "template", "insight", str(CHART), "--values", str(CHART / "tests" / "values.yaml"), *overrides],
        capture_output=True, text=True, timeout=300, check=False,
    )  # fmt: skip
    assert result.returncode == 0, result.stderr
    return [doc for doc in yaml.safe_load_all(result.stdout) if doc]


def _hook_jobs(manifests: list[dict[str, Any]], phase: str) -> dict[str, int]:
    jobs = {}
    for doc in manifests:
        annotations = doc["metadata"].get("annotations") or {}
        if doc["kind"] == "Job" and f"{phase}-upgrade" in annotations.get("helm.sh/hook", ""):
            jobs[doc["metadata"]["name"]] = int(annotations.get("helm.sh/hook-weight", "0"))
    return jobs


def _by_name(manifests: list[dict[str, Any]], kind: str, name: str) -> dict[str, Any]:
    return next(d for d in manifests if d["kind"] == kind and d["metadata"]["name"] == name)


def test_the_migration_runs_after_every_other_pre_upgrade_hook(manifests: list[dict[str, Any]]) -> None:
    jobs = _hook_jobs(manifests, "pre")
    pre = jobs.pop("insight-tenant-cutover-pre")

    assert {"insight-clickhouse-databases", "insight-schedule-db-provision"} <= set(jobs)
    assert pre > max(jobs.values()), jobs


def test_the_rebuild_is_submitted_after_every_other_post_upgrade_hook(manifests: list[dict[str, Any]]) -> None:
    jobs = _hook_jobs(manifests, "post")
    post = jobs.pop("insight-tenant-cutover-post")

    assert {"insight-clickhouse-migrate", "insight-clickhouse-field-value-map"} <= set(jobs)
    assert post > max(jobs.values()), jobs


def test_the_pre_hook_fails_inside_the_helm_timeout_and_never_retries(manifests: list[dict[str, Any]]) -> None:
    spec = _by_name(manifests, "Job", "insight-tenant-cutover-pre")["spec"]
    env = {e["name"]: e.get("value") for e in spec["template"]["spec"]["containers"][0]["env"]}

    assert spec["backoffLimit"] == 0
    assert (
        spec["activeDeadlineSeconds"] + spec["template"]["spec"]["terminationGracePeriodSeconds"] < HELM_TIMEOUT_SECONDS
    )
    assert env["INSIGHT_TENANT_ID"] == TENANT


def test_the_rebuild_resumes_the_writers_only_as_its_last_step(manifests: list[dict[str, Any]]) -> None:
    template = _by_name(manifests, "WorkflowTemplate", "tenant-cutover-rebuild")
    steps = [group[0] for group in template["spec"]["templates"][0]["steps"]]

    assert [s["name"] for s in steps] == ["staging", "identity-seed", "everything-else", "resume-writers"]
    assert steps[-1]["arguments"]["parameters"] == [{"name": "step", "value": "resume"}]
    assert all(
        {"name": "dbt_full_refresh", "value": "true"} in s["arguments"]["parameters"]
        for s in steps
        if "templateRef" in s
    )


def test_the_field_value_map_loader_is_given_the_tenant(manifests: list[dict[str, Any]]) -> None:
    job = _by_name(manifests, "Job", "insight-clickhouse-field-value-map")
    env = {e["name"]: e.get("value") for e in job["spec"]["template"]["spec"]["containers"][0]["env"]}

    assert env["INSIGHT_TENANT_ID"] == TENANT


def test_disabling_the_cutover_renders_none_of_it() -> None:
    manifests = _render([*ENABLED, "--set", "ingestion.tenantCutover.enabled=false"])

    assert not [d["metadata"]["name"] for d in manifests if "tenant-cutover" in d["metadata"]["name"]]
