"""What a bronze row without a valid tenant does to the models that read it.

The CRM staging models read the tenant through `bronze_tenant()`, so a NULL, empty or
non-UUID tenant fails the build of the model that reads it, naming that model; with
`bronze_tenant_on_invalid: warn` the row is kept with an empty tenant, its keys stay
non-NULL, and `not_empty` on each support model's tenant reports it.
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
    return f"not_null_{model}_insight_tenant_id", f"not_empty_{model}_insight_tenant_id"


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


#: The CRM staging model that reads each support model's bronze rows.
READ_BY = {
    "hubspot__support_tickets": "hubspot__crm_tickets",
    "hubspot__support_ticket_field_history": "hubspot__crm_field_history",
    "hubspot__support_field_definitions": "hubspot__crm_property_definitions",
    "hubspot__support_agents": "hubspot__crm_users",
    "hubspot__support_groups": "hubspot__crm_teams",
    "hubspot__support_group_memberships": "hubspot__crm_users",
    "hubspot__support_customers": "hubspot__crm_",
}
GUARD = ": a Bronze insight_tenant_id is NULL, empty or not a UUID"
WARN = ("--vars", "{bronze_tenant_on_invalid: warn}")


@pytest.mark.parametrize("tenant", [None, "", "not-a-uuid"])
@pytest.mark.parametrize("model", sorted(STREAMS))
def test_a_bronze_row_without_a_valid_tenant_fails_the_build(case: Warehouse, model: str, tenant: str | None) -> None:
    _seed(case, tenant, model)

    success, log = case.build_status(f"+{model}")

    assert not success, f"{model} should refuse a bronze row with a tenant of {tenant!r}"
    assert f"staging.{READ_BY[model]}" in log and GUARD in log, f"the failure should name the reader:\n{log}"


@pytest.mark.parametrize("model", sorted(STREAMS))
def test_warn_mode_builds_over_a_bronze_row_without_a_tenant_and_the_tenant_tests_report_it(
    case: Warehouse, model: str
) -> None:
    _seed(case, None, model)
    success, log = case.build_status(f"+{model}", *WARN)
    assert success, log

    failing = case.failing_tests(tenant_tests(model))
    assert f"not_empty_{model}_insight_tenant_id" in failing, f"{model} should report the row: {sorted(failing)}"


def test_warn_mode_carries_a_ticket_without_a_tenant_to_the_support_class(case: Warehouse) -> None:
    _seed(case, None, "hubspot__support_tickets")
    success, log = case.build_status("+class_support_tickets", *WARN)
    assert success, log

    failing = case.failing_tests(tenant_tests("class_support_tickets"))
    assert "not_empty_class_support_tickets_insight_tenant_id" in failing, sorted(failing)


CRM_STAGING = (
    "hubspot__crm_tickets",
    "hubspot__crm_field_history",
    "hubspot__crm_property_definitions",
    "hubspot__crm_users",
    "hubspot__crm_teams",
)


def test_the_crm_staging_carries_a_lowercase_string_tenant(case: Warehouse) -> None:
    _seed(case, TENANT.upper(), *STREAMS)
    case.build(" ".join(CRM_STAGING))

    found = {
        model: case.rows(
            f"SELECT DISTINCT insight_tenant_id AS t, toTypeName(insight_tenant_id) AS type FROM staging.{model}"
        )
        for model in CRM_STAGING
    }
    assert found == dict.fromkeys(CRM_STAGING, [{"t": TENANT, "type": "String"}]), found
