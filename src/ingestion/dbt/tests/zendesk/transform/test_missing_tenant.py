"""What a bronze row without a valid tenant does to the models that read it.

`zendesk_bronze` reads the tenant through `bronze_tenant()`, so a NULL, empty or non-UUID
tenant fails the build of the model that reads it, naming that model; with
`bronze_tenant_on_invalid: warn` the row is kept with an empty tenant and the `not_empty`
test on each model's tenant reports it.
"""

from __future__ import annotations

import pytest
from conftest import TENANT, Warehouse

AT = "2026-01-02T10:00:00Z"
AUDIT = {
    "id": 100,
    "ticket_id": 1,
    "created_at": AT,
    "updater_id": 5,
    "via": "Web",
    "child_events": [
        {"id": 1001, "event_type": "Create", "status": "new"},
        {"id": 1002, "event_type": "Comment", "author_id": 5, "public": True},
    ],
}

#: The model a bronze row reaches, by the stream that carries it.
STREAMS: dict[str, tuple[str, dict[str, object]]] = {
    "zendesk__support_tickets": ("zendesk_tickets", {"id": 1, "status": "open", "tags": [], "custom_fields": []}),
    "zendesk__ticket_event_items": ("zendesk_ticket_events", AUDIT),
    "zendesk__support_ticket_field_history": ("zendesk_ticket_events", AUDIT),
    "zendesk__support_interactions": ("zendesk_ticket_events", AUDIT),
    "zendesk__user_kinds": ("zendesk_users", {"id": 5, "role": "agent", "email": "agent@example.com"}),
    "zendesk__support_agents": ("zendesk_users", {"id": 5, "role": "agent", "email": "agent@example.com"}),
    "zendesk__support_customers": ("zendesk_organizations", {"id": 7, "name": "Example Org"}),
    "zendesk__support_groups": ("zendesk_groups", {"id": 3, "name": "Example Group"}),
    "zendesk__support_group_memberships": ("zendesk_group_memberships", {"id": 4, "user_id": 5, "group_id": 3}),
    "zendesk__support_field_definitions": ("zendesk_ticket_fields", {"id": 900, "type": "text", "title": "Field"}),
    "zendesk__support_satisfaction": ("zendesk_csat_ratings", {"id": 6, "ticket_id": 1, "score": "good"}),
    "zendesk__support_sla_events": (
        "zendesk_ticket_metric_events",
        {"id": 8, "ticket_id": 1, "metric": "reply_time", "instance_id": 1, "type": "activate", "time": AT},
    ),
    "zendesk__support_sla_policies": (
        "zendesk_sla_policies",
        {"id": 9, "title": "Policy", "policy_metrics": [{"metric": "first_reply_time", "target": 60}]},
    ),
    "zendesk__support_schedules": ("zendesk_schedules", {"id": 10, "name": "Schedule", "time_zone": "UTC"}),
    "zendesk__support_kb_articles": (
        "zendesk_kb_articles",
        {"id": 11, "title": "Article", "created_at": AT, "updated_at": AT},
    ),
    "zendesk__support_ticket_issue_links": (
        "zendesk_jira_links",
        {"id": 12, "ticket_id": 1, "issue_id": 10001, "issue_key": "EX-1", "created_at": AT},
    ),
}
SELECTOR = " ".join(STREAMS)

#: The model that reads the bronze row, where it is not the model itself.
READ_BY = {
    "zendesk__support_interactions": "zendesk__ticket_event_items",
    "zendesk__support_ticket_field_history": "zendesk__ticket_event_items",
}
GUARD = "a Bronze insight_tenant_id is NULL, empty or not a UUID"
WARN = ("--vars", "{bronze_tenant_on_invalid: warn}")


def tenant_tests(model: str) -> tuple[str, str]:
    return f"not_null_{model}_insight_tenant_id", f"not_empty_{model}_insight_tenant_id"


def _seed(case: Warehouse, tenant: str | None) -> None:
    for table, payload in {table: payload for table, payload in STREAMS.values()}.items():
        case.insert(table, tenant, str(payload["id"]), payload, "2026-01-10T00:00:00")


def test_the_tenant_tests_pass_over_rows_that_carry_a_tenant(case: Warehouse) -> None:
    _seed(case, TENANT)
    case.build(SELECTOR)

    rows = {model: case.rows(f"SELECT count() AS n FROM staging.{model}")[0]["n"] for model in STREAMS}
    assert all(rows.values()), f"every model should hold the seeded row: {rows}"
    every_test = [name for model in STREAMS for name in tenant_tests(model)]
    assert case.failing_tests(every_test) == set(), "no tenant test should fail while every row carries a tenant"


@pytest.mark.parametrize("tenant", [None, "", "not-a-uuid"])
@pytest.mark.parametrize("model", sorted(STREAMS))
def test_a_bronze_row_without_a_valid_tenant_fails_the_build(case: Warehouse, model: str, tenant: str | None) -> None:
    table, payload = STREAMS[model]
    case.insert(table, tenant, str(payload["id"]), payload, "2026-01-10T00:00:00")

    success, log = case.build_status(f"+{model}")

    assert not success, f"{model} should refuse a {table} row with a tenant of {tenant!r}"
    assert f"staging.{READ_BY.get(model, model)}: {GUARD}" in log, f"the failure should name the reader:\n{log}"


@pytest.mark.parametrize("model", sorted(STREAMS))
def test_warn_mode_builds_over_a_bronze_row_without_a_tenant_and_the_tenant_tests_report_it(
    case: Warehouse, model: str
) -> None:
    table, payload = STREAMS[model]
    case.insert(table, None, str(payload["id"]), payload, "2026-01-10T00:00:00")
    success, log = case.build_status(f"+{model}", *WARN)
    assert success, log

    failing = case.failing_tests(tenant_tests(model))
    assert f"not_empty_{model}_insight_tenant_id" in failing, (
        f"{model} should report the {table} row: {sorted(failing)}"
    )


def test_warn_mode_carries_a_ticket_without_a_tenant_to_the_support_class(case: Warehouse) -> None:
    table, payload = STREAMS["zendesk__support_tickets"]
    case.insert(table, None, "1", payload, "2026-01-10T00:00:00")
    success, log = case.build_status("+class_support_tickets", *WARN)
    assert success, log

    failing = case.failing_tests(tenant_tests("class_support_tickets"))
    assert "not_empty_class_support_tickets_insight_tenant_id" in failing, sorted(failing)


def test_a_bronze_tenant_is_read_as_its_lowercase_canonical_uuid(case: Warehouse) -> None:
    table, payload = STREAMS["zendesk__support_tickets"]
    case.insert(table, TENANT.upper(), "1", payload, "2026-01-10T00:00:00")
    case.build("zendesk__support_tickets")

    rows = case.rows(
        "SELECT insight_tenant_id, toTypeName(insight_tenant_id) AS type FROM staging.zendesk__support_tickets"
    )
    assert rows == [{"insight_tenant_id": TENANT, "type": "String"}], rows
