"""A bronze row without a tenant builds, and the tenant tests on its models report it.

`hubspot_support_scope` reads the tenant through `coalesce(tenant_id, '')`, so a
missing one never makes a key Nullable and arrives as an empty tenant; `not_empty`
on each support model's tenant is the guard, with `not_null` beside it.
"""

from __future__ import annotations

import json

import pytest
from conftest import TENANT, Warehouse, at

TICKET = {
    "id": "1",
    "createdAt": at("2026-01-01T00:00:00"),
    "updatedAt": at("2026-01-05T00:00:00"),
    "archived": False,
    "properties_hs_pipeline_stage": "s1",
    "associations_contacts": json.dumps(["c1"]),
    "raw_data": json.dumps({"properties": {"hs_pipeline_stage": "s1"}}),
}
OWNER = {
    "id": "o77",
    "email": "owner@example.com",
    "userId": 77,
    "archived": False,
    "teams": json.dumps([{"id": "t1", "name": "Team", "primary": True}]),
}

#: The bronze rows that reach a model, by model.
STREAMS: dict[str, list[tuple[str, str, dict[str, object]]]] = {
    "hubspot__support_tickets": [("tickets", "1", TICKET)],
    "hubspot__support_ticket_field_history": [
        (
            "tickets_property_history",
            "h1",
            {
                "id": "h1",
                "objectType": "tickets",
                "objectId": "1",
                "propertyName": "hs_pipeline_stage",
                "value": "s1",
                "timestamp": at("2026-01-02T10:00:00"),
                "updatedByUserId": 77,
            },
        )
    ],
    "hubspot__support_field_definitions": [
        (
            "property_definitions",
            "tickets-custom_prop",
            {"objectType": "tickets", "name": "custom_prop", "type": "string", "fieldType": "text"},
        )
    ],
    "hubspot__support_agents": [("owners", "o77", OWNER)],
    "hubspot__support_groups": [("owners", "o77", OWNER)],
    "hubspot__support_group_memberships": [("owners", "o77", OWNER)],
    "hubspot__support_customers": [("tickets", "1", TICKET), ("contacts", "c1", {"id": "c1", "archived": False})],
}
SELECTOR = " ".join(f"+{model}" for model in STREAMS)


def tenant_tests(model: str) -> tuple[str, str]:
    return f"not_null_{model}_tenant_id", f"not_empty_{model}_tenant_id"


def _seed(case: Warehouse, tenant: str | None, *models: str) -> None:
    rows = {(table, key): row for model in models for table, key, row in STREAMS[model]}
    for (table, key), row in rows.items():
        case.insert(table, tenant, key, row, "2026-01-10T00:00:00")


def test_the_tenant_tests_pass_over_rows_that_carry_a_tenant(case: Warehouse) -> None:
    _seed(case, TENANT, *STREAMS)
    case.build(SELECTOR)

    rows = {model: case.rows(f"SELECT count() AS n FROM staging.{model}")[0]["n"] for model in STREAMS}
    assert all(rows.values()), f"every model should hold the seeded row: {rows}"
    every_test = [name for model in STREAMS for name in tenant_tests(model)]
    assert case.failing_tests(every_test) == set(), "no tenant test should fail while every row carries a tenant"


# BUG: hubspot__crm_field_history and hubspot__crm_teams key a row by
# concat(tenant_id, ...), which is NULL for a NULL tenant, and
# hubspot_staging_tail's `(unique_key, _version) IN (...)` then drops the row:
# it is lost before any tenant test can report it.
DROPPED_BY_CRM_STAGING = {"hubspot__support_ticket_field_history", "hubspot__support_groups"}


@pytest.mark.parametrize(
    "model",
    [
        pytest.param(
            model,
            marks=pytest.mark.xfail(
                strict=True, reason="the CRM staging drops a row without a tenant on a NULL unique_key"
            ),
        )
        if model in DROPPED_BY_CRM_STAGING
        else model
        for model in sorted(STREAMS)
    ],
)
def test_a_bronze_row_without_a_tenant_builds_and_the_tenant_tests_report_it(case: Warehouse, model: str) -> None:
    _seed(case, None, model)
    case.build(f"+{model}")

    failing = case.failing_tests(tenant_tests(model))
    assert f"not_empty_{model}_tenant_id" in failing, f"{model} should report the row: {sorted(failing)}"


def test_the_support_class_reports_a_ticket_without_a_tenant(case: Warehouse) -> None:
    _seed(case, None, "hubspot__support_tickets")
    case.build("+class_support_tickets")

    failing = case.failing_tests(tenant_tests("class_support_tickets"))
    assert "not_empty_class_support_tickets_tenant_id" in failing, sorted(failing)
