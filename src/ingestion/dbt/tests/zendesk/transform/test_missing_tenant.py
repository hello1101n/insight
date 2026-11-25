"""A bronze row without a tenant builds, and the tenant tests on its models report it.

`zendesk_bronze` reads the tenant through `coalesce(tenant_id, '')`, so a missing
one never makes a key Nullable and arrives as an empty tenant; `not_empty` on each
model's tenant is the guard, with `not_null` beside it.
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


def tenant_tests(model: str) -> tuple[str, str]:
    return f"not_null_{model}_tenant_id", f"not_empty_{model}_tenant_id"


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


@pytest.mark.parametrize("model", sorted(STREAMS))
def test_a_bronze_row_without_a_tenant_builds_and_the_tenant_tests_report_it(case: Warehouse, model: str) -> None:
    table, payload = STREAMS[model]
    case.insert(table, None, str(payload["id"]), payload, "2026-01-10T00:00:00")
    case.build(f"+{model}")

    failing = case.failing_tests(tenant_tests(model))
    assert f"not_empty_{model}_tenant_id" in failing, f"{model} should report the {table} row: {sorted(failing)}"


def test_the_support_class_reports_a_ticket_without_a_tenant(case: Warehouse) -> None:
    table, payload = STREAMS["zendesk__support_tickets"]
    case.insert(table, None, "1", payload, "2026-01-10T00:00:00")
    case.build("+class_support_tickets")

    failing = case.failing_tests(tenant_tests("class_support_tickets"))
    assert "not_empty_class_support_tickets_tenant_id" in failing, sorted(failing)
