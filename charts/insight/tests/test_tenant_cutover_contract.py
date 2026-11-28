"""The tenant cutover hooks run in the order the cutover needs, inside a 3h helm timeout.

Run: pytest charts/insight/tests
"""

from __future__ import annotations

import re
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


def test_the_rebuild_runs_every_step_and_always_resumes_the_writers_at_its_end(manifests: list[dict[str, Any]]) -> None:
    spec = _by_name(manifests, "WorkflowTemplate", "tenant-cutover-rebuild")["spec"]
    steps = [group[0] for group in spec["templates"][0]["steps"]]
    staging = next(s for s in steps if s["name"] == "staging")

    assert [s["name"] for s in steps] == ["staging", "identity-seed", "everything-else", "report"]
    assert spec["onExit"] == "resume-writers", "the writers resume however the Workflow ends"
    assert all(s.get("continueOn") == {"failed": True} for s in steps[:-1]), "a failed step stops none after it"
    assert steps[-1]["template"] == "report" and all(
        f"'{{{{steps.{s['name']}.status}}}}' != 'Succeeded'" in steps[-1]["when"] for s in steps[:-1]
    ), "any failed step fails the Workflow"
    assert {"name": "dbt_select", "value": "+tag:staging +identity_inputs tag:identity:map"} in staging["arguments"][
        "parameters"
    ]
    assert all(
        {"name": "dbt_full_refresh", "value": "true"} in s["arguments"]["parameters"]
        for s in steps
        if "templateRef" in s
    )


def test_no_input_reaches_a_command_and_only_the_two_cutover_steps_run_as_its_account(
    manifests: list[dict[str, Any]],
) -> None:
    """Anyone who may submit a Workflow can pick any template as its entrypoint."""
    spec = _by_name(manifests, "WorkflowTemplate", "tenant-cutover-rebuild")["spec"]
    templates = {t["name"]: t for t in spec["templates"]}

    report = spec["templates"][0]["steps"][-1][0]
    expressions = re.findall(r"\{\{[^}]*\}\}", yaml.safe_dump(spec))

    assert spec["serviceAccountName"] == "argo-workflow"
    assert not any("inputs" in t for t in templates.values())
    assert expressions, "the report step reads step statuses"
    assert all(re.fullmatch(r"\{\{steps\.[a-z-]+\.status\}\}", e) for e in expressions), expressions
    assert all(e in report["when"] for e in expressions), "a status is read only by the report step's condition"
    assert templates["report"]["container"]["command"] == ["bash", "/ingestion/scripts/tenant-cutover.sh", "report"]
    assert {n: t.get("serviceAccountName") for n, t in templates.items() if t.get("serviceAccountName")} == {
        "identity-seed": "insight-tenant-cutover",
        "resume-writers": "insight-tenant-cutover",
    }
    assert templates["identity-seed"]["container"]["command"] == [
        "bash",
        "/ingestion/scripts/tenant-cutover.sh",
        "seed",
    ]
    assert templates["resume-writers"]["container"]["command"] == [
        "bash",
        "/ingestion/scripts/tenant-cutover.sh",
        "resume",
    ]


def test_the_dbt_step_deadline_is_a_number_and_reaches_only_the_deadline(manifests: list[dict[str, Any]]) -> None:
    run = _by_name(manifests, "WorkflowTemplate", "dbt-run")["spec"]["templates"][0]
    rebuild = _by_name(manifests, "WorkflowTemplate", "tenant-cutover-rebuild")["spec"]["templates"][0]
    deadlines = [
        p["value"]
        for group in rebuild["steps"]
        for p in group[0].get("arguments", {}).get("parameters", [])
        if p["name"] == "active_deadline_seconds"
    ]

    assert run["activeDeadlineSeconds"] == "{{inputs.parameters.active_deadline_seconds}}"
    assert "active_deadline_seconds" not in yaml.safe_dump(
        {k: v for k, v in run.items() if k not in ("inputs", "activeDeadlineSeconds")}
    )
    assert deadlines and all(d.isdigit() for d in deadlines), deadlines


def test_a_step_deadline_that_is_not_a_number_fails_the_render() -> None:
    result = subprocess.run(
        ["helm", "template", "insight", str(CHART), "--values", str(CHART / "tests" / "values.yaml"),
         "--set-string", "ingestion.tenantCutover.dbtStepDeadlineSeconds=60 x"],
        capture_output=True, text=True, timeout=300, check=False,
    )  # fmt: skip

    assert result.returncode != 0
    assert "dbtStepDeadlineSeconds must be a positive whole number" in result.stderr


def test_the_field_value_map_loader_is_given_the_tenant(manifests: list[dict[str, Any]]) -> None:
    job = _by_name(manifests, "Job", "insight-clickhouse-field-value-map")
    env = {e["name"]: e.get("value") for e in job["spec"]["template"]["spec"]["containers"][0]["env"]}

    assert env["INSIGHT_TENANT_ID"] == TENANT


def _render_failure(overrides: list[str]) -> str:
    result = subprocess.run(
        ["helm", "template", "insight", str(CHART), "--values", str(CHART / "tests" / "values.yaml"), *overrides],
        capture_output=True, text=True, timeout=300, check=False,
    )  # fmt: skip
    assert result.returncode != 0, "the render must fail"
    return result.stderr


def test_an_upgrade_whose_helm_gives_up_before_the_migration_fails_the_render() -> None:
    """A helm that times out or rolls back mid-migration leaves the old release on renamed columns."""
    stderr = _render_failure(["--is-upgrade", "--set", "ingestion.tenantCutover.helmTimeoutSeconds=600"])

    assert "helmTimeoutSeconds is 600" in stderr and "without --rollback-on-failure" in stderr


def test_an_upgrade_with_a_timeout_that_outwaits_the_pre_hook_renders(manifests: list[dict[str, Any]]) -> None:
    spec = _by_name(manifests, "Job", "insight-tenant-cutover-pre")["spec"]
    needed = spec["activeDeadlineSeconds"] + spec["template"]["spec"]["terminationGracePeriodSeconds"]

    upgraded = _render(
        [*ENABLED, "--is-upgrade", "--set", f"ingestion.tenantCutover.helmTimeoutSeconds={HELM_TIMEOUT_SECONDS}"]
    )
    assert needed < HELM_TIMEOUT_SECONDS
    assert _by_name(upgraded, "Job", "insight-tenant-cutover-pre")
    assert _render([*ENABLED, "--set", "ingestion.tenantCutover.helmTimeoutSeconds=600"]), (
        "a fresh install migrates nothing"
    )


def test_a_cluster_mode_upgrade_fails_the_render() -> None:
    """The migration refuses replicated tables: every such deploy would fail at its pre-upgrade hook."""
    stderr = _render_failure(
        ["--is-upgrade", "--set", "clickhouse.clusterMode=true", "--set", "clickhouse.clusterName=insight_cluster"]
    )

    assert "single-node ClickHouse only" in stderr


def test_the_cutover_always_renders_and_has_no_switch(manifests: list[dict[str, Any]]) -> None:
    """The heals after the migration assume it ran; with nothing pending it is a no-op."""
    values = yaml.safe_load((CHART / "values.yaml").read_text())

    assert "enabled" not in values["ingestion"]["tenantCutover"]
    assert _by_name(manifests, "Job", "insight-tenant-cutover-pre")
    assert _by_name(manifests, "WorkflowTemplate", "tenant-cutover-rebuild")


def test_the_rebuild_outlasts_its_steps_so_its_exit_handler_resumes_the_writers(
    manifests: list[dict[str, Any]],
) -> None:
    spec = _by_name(manifests, "WorkflowTemplate", "tenant-cutover-rebuild")["spec"]
    templates = {t["name"]: t for t in spec["templates"]}
    steps = [group[0] for group in spec["templates"][0]["steps"]]
    deadlines = [
        int(p["value"])
        for s in steps
        for p in s.get("arguments", {}).get("parameters", [])
        if p["name"] == "active_deadline_seconds"
    ]
    seed = templates["identity-seed"]["activeDeadlineSeconds"]

    assert len(deadlines) == 2 and seed
    assert spec["activeDeadlineSeconds"] > sum(deadlines) + seed, "a step's own deadline must come first"
    assert spec["onExit"] == "resume-writers"
    assert "activeDeadlineSeconds" not in templates["resume-writers"]


def test_the_identity_map_views_are_rebuilt_in_the_first_step(manifests: list[dict[str, Any]]) -> None:
    """Until rebuilt they read columns the migration renamed, and analytics person queries fail."""
    spec = _by_name(manifests, "WorkflowTemplate", "tenant-cutover-rebuild")["spec"]
    first = spec["templates"][0]["steps"][0][0]
    rest = spec["templates"][0]["steps"][2][0]
    select = next(p["value"] for p in first["arguments"]["parameters"] if p["name"] == "dbt_select")
    exclude = next(p["value"] for p in rest["arguments"]["parameters"] if p["name"] == "dbt_exclude")

    assert "tag:identity:map" in select.split()
    assert exclude == select
