"""A GitLab note without a tenant fails the build instead of vanishing in the project join.

`gitlab__pull_requests_comments` INNER JOINs the project roster on the tenant, so a NULL
tenant used to drop the note without a word. Its tenant now goes through `bronze_tenant()`.
"""

from __future__ import annotations

from conftest import SOURCE, TENANT, Warehouse

MODEL = "gitlab__pull_requests_comments"
GUARD_MESSAGE = f"staging.{MODEL}: a Bronze n.insight_tenant_id is NULL, empty or not a UUID"
WARN = ("--vars", "{bronze_tenant_on_invalid: warn}")

PROJECT = {"unique_key": f"{SOURCE}-project-1", "id": 1, "namespace_full_path": "example-group", "path": "example"}
NOTE = {
    "unique_key": f"no-tenant-{SOURCE}-note-1",
    "project_id": 1,
    "mr_iid": 7,
    "id": 1,
    "body": "looks good",
    "system": False,
    "author_username": "example-user",
    "author_id": 101,
    "created_at": "2026-01-02T00:00:00Z",
}


def _seed(case: Warehouse, tenant: str | None, project_tenant: str | None = TENANT) -> None:
    case.insert("repositories", project_tenant, PROJECT, "2026-01-10T00:00:00", database="bronze_gitlab")
    case.insert("pull_request_notes", tenant, NOTE, "2026-01-10T00:00:00", database="bronze_gitlab")


def test_a_tenanted_note_reaches_staging(case: Warehouse) -> None:
    _seed(case, TENANT)
    case.build(MODEL, full_refresh=True)

    assert case.rows(f"SELECT insight_tenant_id FROM staging.{MODEL}") == [{"insight_tenant_id": TENANT}]


def test_a_note_without_a_tenant_fails_the_build(case: Warehouse) -> None:
    _seed(case, None)

    success, log = case.build_status(MODEL, full_refresh=True)

    assert not success, f"{MODEL} should refuse a note without a tenant"
    assert GUARD_MESSAGE in log, log


def test_warn_mode_keeps_the_note_and_the_not_empty_test_reports_it(case: Warehouse) -> None:
    # A sync that lost the tenant lost it on the project too; warn mode reads both as ''.
    _seed(case, None, project_tenant=None)

    success, log = case.build_status(MODEL, *WARN, full_refresh=True)
    failing = case.failing_tests((f"not_null_{MODEL}_insight_tenant_id", f"not_empty_{MODEL}_insight_tenant_id"))

    assert success, log
    assert failing == {f"not_empty_{MODEL}_insight_tenant_id"}, sorted(failing)
