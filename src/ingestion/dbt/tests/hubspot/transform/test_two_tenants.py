"""Two tenants that share a source id and HubSpot ids stay apart in the support models.

A source id names a connector instance inside one tenant, and HubSpot ids are
unique only inside one portal, so two tenants can hold the very same ticket,
stage, owner and contact ids with different contents. Every join, group and
window up to the class_support_* union keys by tenant first.
"""

from __future__ import annotations

import json

from conftest import OTHER_TENANT, SOURCE, TENANT, Warehouse, at

STAGE_CHANGED = "2026-01-02T10:00:00"
OWNER_CHANGED = "2026-01-03T10:00:00"
# Stage s1 closes a ticket in this tenant and leaves it open in the other.
TICKET_STATES = {TENANT: "CLOSED", OTHER_TENANT: "OPEN"}


def _ticket(case: Warehouse, tenant: str, ticket_id: str, properties: dict[str, str], contacts: list[str]) -> None:
    case.insert(
        "tickets",
        tenant,
        ticket_id,
        {
            "id": ticket_id,
            "createdAt": at("2026-01-01T00:00:00"),
            "updatedAt": at("2026-01-05T00:00:00"),
            "archived": False,
            "properties_hs_pipeline": "p1",
            "properties_hs_pipeline_stage": "s1",
            "properties_hs_is_closed": "false",
            "associations_contacts": json.dumps(contacts),
            "raw_data": json.dumps({"properties": {"hs_pipeline_stage": "s1", **properties}}),
        },
        "2026-01-10T00:00:00",
    )


def _change(case: Warehouse, tenant: str, change_id: str, prop: str, value: str, changed: str) -> None:
    case.insert(
        "tickets_property_history",
        tenant,
        change_id,
        {
            "id": change_id,
            "objectType": "tickets",
            "objectId": "1",
            "propertyName": prop,
            "value": value,
            "timestamp": at(changed),
            "sourceType": "CRM_UI",
            "updatedByUserId": 77,
        },
        "2026-01-10T00:00:00",
    )


def _seed(case: Warehouse) -> None:
    """Ticket 1, stage s1, owner 77, property custom_prop and contact c1 in both tenants.

    Here stage s1 closes, owner 77 exists, custom_prop is custom and ticket 1
    names contact c1; there s1 stays open, ticket 2 absorbs ticket 1 by merge,
    nobody is owner 77 and custom_prop is HubSpot's own.
    """
    for tenant in (TENANT, OTHER_TENANT):
        case.insert(
            "ticket_pipelines",
            tenant,
            "p1",
            {
                "id": "p1",
                "objectType": "tickets",
                "label": "Support",
                "archived": False,
                "stages": json.dumps(
                    [{"id": "s1", "label": "Stage", "metadata": {"ticketState": TICKET_STATES[tenant]}}]
                ),
            },
            "2026-01-10T00:00:00",
        )
        case.insert(
            "property_definitions",
            tenant,
            "tickets-custom_prop",
            {
                "objectType": "tickets",
                "name": "custom_prop",
                "label": "Custom",
                "type": "string",
                "fieldType": "text",
                "hubspotDefined": tenant == OTHER_TENANT,
            },
            "2026-01-10T00:00:00",
        )
        case.insert("contacts", tenant, "c1", {"id": "c1", "archived": False}, "2026-01-10T00:00:00")
        _change(case, tenant, "h1", "hs_pipeline_stage", "s1", STAGE_CHANGED)
        _ticket(case, tenant, "1", {"custom_prop": "v"}, ["c1"] if tenant == TENANT else [])

    case.insert(
        "owners",
        TENANT,
        "o77",
        {"id": "o77", "email": "owner@example.com", "userId": 77, "archived": False, "teams": "[]"},
        "2026-01-10T00:00:00",
    )
    _change(case, TENANT, "h2", "hubspot_owner_id", "o77", OWNER_CHANGED)
    _ticket(case, OTHER_TENANT, "2", {"hs_merged_object_ids": "1"}, [])


def _by_tenant(rows: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    found: dict[str, dict[str, object]] = {}
    for row in rows:
        tenant = str(row.pop("insight_tenant_id"))
        assert tenant not in found, f"{tenant} has more than one row: {rows}"
        found[tenant] = row
    return found


def test_each_tenant_reads_its_own_stage_merge_and_custom_properties(case: Warehouse) -> None:
    _seed(case)
    case.build("+hubspot__support_tickets")

    found = _by_tenant(
        case.rows(
            "SELECT insight_tenant_id, unique_key, status, availability, merged_into_id, custom_attrs"
            f" FROM staging.hubspot__support_tickets FINAL WHERE insight_source_id = '{SOURCE}' AND ticket_id = '1'"
        )
    )

    assert found == {
        TENANT: {
            "unique_key": f"{TENANT}-{SOURCE}-1",
            "status": "closed",
            "availability": "present",
            "merged_into_id": None,
            "custom_attrs": '{"custom_prop":"v"}',
        },
        OTHER_TENANT: {
            "unique_key": f"{OTHER_TENANT}-{SOURCE}-1",
            "status": "open",
            "availability": "merged",
            "merged_into_id": "2",
            "custom_attrs": "{}",
        },
    }, found


def test_each_tenant_orders_and_attributes_its_own_ticket_history(case: Warehouse) -> None:
    _seed(case)
    case.build("+hubspot__support_ticket_field_history")

    history: dict[str, list[tuple[object, ...]]] = {}
    for row in case.rows(
        "SELECT insight_tenant_id, event_order, field_id, value, actor_id"
        " FROM staging.hubspot__support_ticket_field_history FINAL"
        f" WHERE insight_source_id = '{SOURCE}' AND ticket_id = '1' ORDER BY insight_tenant_id, event_order"
    ):
        history.setdefault(str(row["insight_tenant_id"]), []).append(
            (row["event_order"], row["field_id"], row["value"], row["actor_id"])
        )

    assert history == {
        TENANT: [
            (1, "hs_pipeline_stage", '"s1"', "o77"),
            (2, "status", '"closed"', "o77"),
            (3, "assignee_id", '"o77"', "o77"),
        ],
        OTHER_TENANT: [(1, "hs_pipeline_stage", '"s1"', None), (2, "status", '"open"', None)],
    }, history


def test_a_contact_is_a_customer_only_where_a_ticket_names_it(case: Warehouse) -> None:
    _seed(case)
    case.build("+hubspot__support_customers")

    found = case.rows(
        "SELECT insight_tenant_id, unique_key FROM staging.hubspot__support_customers FINAL"
        f" WHERE insight_source_id = '{SOURCE}' AND customer_id = 'c1'"
    )

    assert found == [{"insight_tenant_id": TENANT, "unique_key": f"{TENANT}-{SOURCE}-user-c1"}], found


CLASSES = {
    "class_support_tickets": ("ticket_id = '1'", [OTHER_TENANT, TENANT]),
    "class_support_ticket_field_history": ("ticket_id = '1' AND event_order = 1", [OTHER_TENANT, TENANT]),
    "class_support_field_definitions": ("field_id = 'custom_prop'", [OTHER_TENANT, TENANT]),
    "class_support_customers": ("customer_id = 'c1'", [TENANT]),
}


def test_the_support_classes_keep_one_row_per_tenant(case: Warehouse) -> None:
    _seed(case)
    case.build(" ".join(f"+{name}" for name in CLASSES))

    for name, (where, expected) in CLASSES.items():
        rows = case.rows(
            f"SELECT insight_tenant_id, unique_key FROM silver.{name} FINAL"
            f" WHERE data_source = 'hubspot' AND insight_source_id = '{SOURCE}' AND {where} ORDER BY insight_tenant_id"
        )
        assert [r["insight_tenant_id"] for r in rows] == expected, f"{name}: {rows}"
        assert all(str(r["unique_key"]).startswith(f"{r['insight_tenant_id']}-{SOURCE}-") for r in rows), (
            f"{name}: {rows}"
        )
