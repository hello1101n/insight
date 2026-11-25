"""What a bronze row without a valid tenant does to the GitHub model that reads it.

Every GitHub staging model reads its tenant through `bronze_tenant()`: a NULL, empty or
non-UUID tenant fails the build of the model that reads it, naming that model. With
`bronze_tenant_on_invalid: warn` the model builds, the row is kept with an empty tenant,
and the model's `not_empty` tenant test reports it.
"""

from __future__ import annotations

from collections.abc import Mapping

import pytest
from conftest import SOURCE, TENANT, Warehouse

WARN = ("--vars", "{bronze_tenant_on_invalid: warn}")


def tenant_tests(model: str) -> tuple[str, str]:
    return f"not_null_{model}_insight_tenant_id", f"not_empty_{model}_insight_tenant_id"


def guard_message(model: str, column: str) -> str:
    return f"staging.{model}: a Bronze {column} is NULL, empty or not a UUID"


LINK_EVENT = {
    "unique_key": f"no-tenant-{SOURCE}-link-1",
    "event_id": "link-1",
    "event_type": "ConnectedEvent",
    "event_at": "2026-01-02T00:00:00Z",
    "item_number": 1,
    "repo_full_name": "example-org/example-repo",
    "actor_login": "example-user",
    "link_target_type": "Issue",
    "link_target_repo_full_name": "example-org/example-repo",
    "link_target_number": 2,
}

PULL_REQUEST = {
    "unique_key": f"{SOURCE}-pr-7",
    "repo_full_name": "example-org/example-repo",
    "number": 7,
    "title": "Example",
    "state": "open",
}


class Case:
    def __init__(
        self,
        table: str,
        row: Mapping[str, object],
        model: str,
        column: str,
        tenanted: tuple[tuple[str, Mapping[str, object]], ...] = (),
    ) -> None:
        self.table, self.row, self.model, self.column, self.tenanted = table, row, model, column, tenanted


# selector -> the bronze row without a tenant, the model that reads it and the column it guards
CASES: dict[str, Case] = {
    "github__item_events": Case(
        "pull_request_timeline_events",
        {
            **LINK_EVENT,
            "unique_key": f"no-tenant-{SOURCE}-closed-1",
            "event_id": "closed-1",
            "event_type": "ClosedEvent",
        },
        "github__item_events",
        "e.insight_tenant_id",
    ),
    # The link events are a view, so the guard fires when github__task_links reads it.
    "+github__task_links": Case("issue_timeline_events", LINK_EVENT, "github__issue_link_events", "insight_tenant_id"),
    "+github__unowned_commit_emails": Case(
        "commits",
        {
            "unique_key": f"no-tenant-{SOURCE}-sha-1",
            "repository": "example-org/example-repo",
            "sha": "sha-1",
            "authored_date": "2026-01-02T00:00:00Z",
            "author_name": "Example Author",
            "author_email": "author@example.com",
        },
        "github__unowned_commit_emails",
        "insight_tenant_id",
    ),
    # The INNER JOIN to the pull request used to drop a tenantless comment without a word.
    "github__pull_requests_comments": Case(
        "pull_request_comments",
        {
            "unique_key": f"no-tenant-{SOURCE}-comment-1",
            "repo_full_name": "example-org/example-repo",
            "issue_number": 7,
            "id": 1,
            "body": "looks good",
            "author_login": "example-user",
            "created_at": "2026-01-02T00:00:00Z",
        },
        "github__pull_requests_comments",
        "c.insight_tenant_id",
        tenanted=(("pull_requests", PULL_REQUEST),),
    ),
}


def _seed(case: Warehouse, spec: Case, tenant: str | None, partner_tenant: str | None = TENANT) -> None:
    for table, row in spec.tenanted:
        case.insert(table, partner_tenant, row, "2026-01-10T00:00:00")
    case.insert(spec.table, tenant, spec.row, "2026-01-10T00:00:00")


def test_the_tenant_tests_pass_over_rows_that_carry_a_tenant(case: Warehouse) -> None:
    for spec in CASES.values():
        _seed(case, spec, TENANT)
    for selector in CASES:
        case.build(selector, full_refresh=True)

    every_test = [name for spec in CASES.values() for name in tenant_tests(spec.model)]
    assert case.failing_tests(every_test) == set(), "no tenant test should fail while every row carries a tenant"


@pytest.mark.parametrize("selector", sorted(CASES))
def test_a_bronze_row_without_a_tenant_fails_the_build_of_the_model_that_reads_it(
    case: Warehouse, selector: str
) -> None:
    spec = CASES[selector]
    _seed(case, spec, None)

    success, log = case.build_status(selector, full_refresh=True)

    assert not success, f"{selector} should refuse a {spec.table} row without a tenant"
    assert guard_message(spec.model, spec.column) in log, f"the failure should name the model and the problem:\n{log}"


@pytest.mark.parametrize("tenant", ["", "not-a-uuid", "gbcdefab-1111-2222-3333-444455556666"])
def test_a_bronze_row_with_an_invalid_tenant_fails_the_build(case: Warehouse, tenant: str) -> None:
    spec = CASES["github__item_events"]
    _seed(case, spec, tenant)

    success, log = case.build_status("github__item_events", full_refresh=True)

    assert not success, f"github__item_events should refuse a tenant of {tenant!r}"
    assert guard_message(spec.model, spec.column) in log, log


@pytest.mark.parametrize("selector", sorted(CASES))
def test_warn_mode_builds_and_the_not_empty_test_reports_the_row(case: Warehouse, selector: str) -> None:
    spec = CASES[selector]
    # A sync that lost the tenant lost it on the joined rows too; warn mode reads both as ''.
    _seed(case, spec, None, partner_tenant=None)

    success, log = case.build_status(selector, *WARN, full_refresh=True)
    failing = case.failing_tests(tenant_tests(spec.model))

    assert success, f"{selector} should build in warn mode:\n{log}"
    assert failing == {f"not_empty_{spec.model}_insight_tenant_id"}, f"warn mode keeps the row as '': {sorted(failing)}"


def test_a_bronze_tenant_is_read_as_its_lowercase_canonical_uuid(case: Warehouse) -> None:
    spec = CASES["github__item_events"]
    _seed(case, spec, TENANT.upper())
    case.build("github__item_events", full_refresh=True)

    rows = case.rows("SELECT insight_tenant_id, toTypeName(insight_tenant_id) AS type FROM staging.github__item_events")
    assert rows == [{"insight_tenant_id": TENANT, "type": "String"}], rows


IDENTITY_AUTHOR = {
    "unique_key": f"no-tenant-{SOURCE}-author@example.com",
    "repo_full_name": "example-org/example-repo",
    "author_email": "author@example.com",
    "author_login": "example-login",
    "author_id": 101,
    "collected_at": "2026-01-10T00:00:00Z",
}


def test_the_identity_inputs_refuse_a_bronze_row_without_a_tenant(case: Warehouse) -> None:
    case.insert("commit_authors", None, IDENTITY_AUTHOR, "2026-01-10T00:00:00")

    with pytest.raises(AssertionError, match="Cannot parse UUID|NULL, empty or not a UUID"):
        case.build("+github__identity_inputs")
