"""Two tenants that share a source id and Zendesk ids stay apart in the support models.

A source id names a connector instance inside one tenant, and Zendesk ids are
unique only inside one account, so two tenants can hold the very same ticket,
audit, user and field ids with different contents. Every join, group and window
up to the class_support_* union keys by tenant first.
"""

from __future__ import annotations

from conftest import OTHER_TENANT, SOURCE, TENANT, Warehouse

CREATED = "2026-01-02T10:00:00Z"
CLOSED = "2026-01-03T10:00:00Z"
MERGED = "2026-01-04T10:00:00Z"
DELETED = "2026-01-05T10:00:00Z"
RATED = "2026-01-06T10:00:00Z"
# INVARIANT: the other tenant assigns later, so an owner lookup that ignores the
# tenant hands this tenant's rating the other tenant's assignee.
ASSIGNED = {TENANT: ("11", "2026-01-02T10:00:00Z"), OTHER_TENANT: ("22", "2026-01-02T11:00:00Z")}
ROLES = {TENANT: "agent", OTHER_TENANT: "end-user"}
FIELD_TYPES = {TENANT: "multiselect", OTHER_TENANT: "text"}
ISSUE_KEYS = {TENANT: ("MINE-1", "2026-01-10T00:00:00"), OTHER_TENANT: ("THEIRS-1", "2026-01-12T00:00:00")}


def _audit(case: Warehouse, tenant: str, audit_id: int, at: str, *children: dict[str, object]) -> None:
    case.insert(
        "zendesk_ticket_events",
        tenant,
        str(audit_id),
        {
            "id": audit_id,
            "ticket_id": 1,
            "created_at": at,
            "updater_id": 5,
            "via": "Web",
            "child_events": list(children),
        },
        "2026-01-10T00:00:00",
    )


def _seed(case: Warehouse) -> None:
    """Ticket 1, user 5 and field 900 in both tenants, each with its own story.

    This tenant closes and deletes the ticket; the other merges it into ticket 9.
    User 5 is an agent here and an end user there; field 900 is a multi-select
    here and a text field there.
    """
    for tenant in (TENANT, OTHER_TENANT):
        assignee, assigned_at = ASSIGNED[tenant]
        case.insert(
            "zendesk_tickets",
            tenant,
            "1",
            {"id": 1, "status": "open", "via": {"channel": "web"}, "tags": [], "custom_fields": []},
            "2026-01-10T00:00:00",
        )
        case.insert("zendesk_users", tenant, "5", {"id": 5, "role": ROLES[tenant]}, "2026-01-10T00:00:00")
        case.insert(
            "zendesk_ticket_fields",
            tenant,
            "900",
            {"id": 900, "type": FIELD_TYPES[tenant], "title": "Synthetic field", "active": True},
            "2026-01-10T00:00:00",
        )
        _audit(case, tenant, 100, CREATED, {"id": 1001, "event_type": "Create", "status": "new"})
        _audit(case, tenant, 101, assigned_at, {"id": 1011, "event_type": "Change", "assignee_id": assignee})
        _audit(
            case,
            tenant,
            102,
            "2026-01-02T12:00:00Z",
            {"id": 1021, "event_type": "Change", "custom_ticket_fields": {"900": "x y"}},
            {"id": 1022, "event_type": "Comment", "author_id": 5, "public": True},
        )
        case.insert(
            "zendesk_survey_responses",
            tenant,
            "sr-1",
            {
                "id": "sr-1",
                "created_at": RATED,
                "subjects": [{"type": "ticket", "id": "1"}],
                "answers": [{"type": "rating_scale", "rating": 5, "rating_category": "good", "updated_at": RATED}],
            },
            "2026-01-10T00:00:00",
        )
        issue_key, collected = ISSUE_KEYS[tenant]
        case.insert(
            "zendesk_jira_links",
            tenant,
            "1",
            {"id": 1, "ticket_id": 1, "issue_id": 10001, "issue_key": issue_key, "created_at": CREATED},
            collected,
        )

    _audit(case, TENANT, 103, CLOSED, {"id": 1031, "event_type": "Change", "status": "closed"})
    case.insert(
        "zendesk_deleted_tickets",
        TENANT,
        "1",
        {"id": 1, "deleted_at": DELETED, "actor": {"id": 5}},
        "2026-01-10T00:00:00",
    )
    case.insert(
        "zendesk_merge_audits",
        OTHER_TENANT,
        "500",
        {
            "id": 500,
            "ticket_id": 1,
            "created_at": MERGED,
            "author_id": 5,
            "via": {"source": {"from": {"ticket_id": 9}}},
        },
        "2026-01-10T00:00:00",
    )


def _by_tenant(rows: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    found: dict[str, dict[str, object]] = {}
    for row in rows:
        tenant = str(row.pop("tenant_id"))
        assert tenant not in found, f"{tenant} has more than one row: {rows}"
        found[tenant] = row
    return found


def test_each_tenant_keeps_its_own_ticket_availability_and_close(case: Warehouse) -> None:
    _seed(case)
    case.build("+zendesk__support_tickets")

    found = _by_tenant(
        case.rows(
            "SELECT tenant_id, unique_key, availability, merged_into_id, toString(closed_at) AS closed_at"
            f" FROM staging.zendesk__support_tickets FINAL WHERE insight_source_id = '{SOURCE}' AND ticket_id = '1'"
        )
    )

    assert found == {
        TENANT: {
            "unique_key": f"{TENANT}-{SOURCE}-1",
            "availability": "deleted",
            "merged_into_id": None,
            "closed_at": "2026-01-03 10:00:00.000",
        },
        OTHER_TENANT: {
            "unique_key": f"{OTHER_TENANT}-{SOURCE}-1",
            "availability": "merged",
            "merged_into_id": "9",
            "closed_at": None,
        },
    }, found


def test_each_tenant_orders_its_own_ticket_history(case: Warehouse) -> None:
    _seed(case)
    case.build("+zendesk__support_ticket_field_history")

    history: dict[str, list[tuple[object, ...]]] = {}
    for row in case.rows(
        "SELECT tenant_id, event_order, field_id, value, field_cardinality, actor_kind"
        " FROM staging.zendesk__support_ticket_field_history FINAL"
        f" WHERE insight_source_id = '{SOURCE}' AND ticket_id = '1' ORDER BY tenant_id, event_order"
    ):
        history.setdefault(str(row["tenant_id"]), []).append(
            (row["event_order"], row["field_id"], row["value"], row["field_cardinality"], row["actor_kind"])
        )

    assert history == {
        TENANT: [
            (1, "status", '"new"', "single", "agent"),
            (2, "assignee_id", '"11"', "single", "agent"),
            (3, "900", '["x","y"]', "multi", "agent"),
            (4, "status", '"closed"', "single", "agent"),
            (5, "availability", '"deleted"', "single", "agent"),
        ],
        OTHER_TENANT: [
            (1, "status", '"new"', "single", "end_user"),
            (2, "assignee_id", '"22"', "single", "end_user"),
            (3, "900", '"x y"', "single", "end_user"),
            (4, "availability", '"merged"', "single", "end_user"),
        ],
    }, history


def test_each_tenant_attributes_its_own_comments(case: Warehouse) -> None:
    _seed(case)
    case.build("+zendesk__support_interactions")

    found = _by_tenant(
        case.rows(
            "SELECT tenant_id, unique_key, author_kind FROM staging.zendesk__support_interactions FINAL"
            f" WHERE insight_source_id = '{SOURCE}' AND interaction_id = '1022'"
        )
    )

    assert found == {
        TENANT: {"unique_key": f"{TENANT}-{SOURCE}-1022", "author_kind": "agent"},
        OTHER_TENANT: {"unique_key": f"{OTHER_TENANT}-{SOURCE}-1022", "author_kind": "end_user"},
    }, found


def test_each_tenants_rating_names_its_own_assignee(case: Warehouse) -> None:
    _seed(case)
    case.build("+zendesk__support_satisfaction")

    found = _by_tenant(
        case.rows(
            "SELECT tenant_id, unique_key, assignee_id FROM staging.zendesk__support_satisfaction FINAL"
            f" WHERE insight_source_id = '{SOURCE}' AND rating_id = 'sr-1'"
        )
    )

    assert found == {
        TENANT: {"unique_key": f"{TENANT}-{SOURCE}-survey-sr-1", "assignee_id": "11"},
        OTHER_TENANT: {"unique_key": f"{OTHER_TENANT}-{SOURCE}-survey-sr-1", "assignee_id": "22"},
    }, found


def test_each_tenant_keeps_its_own_issue_link(case: Warehouse) -> None:
    _seed(case)
    case.build("zendesk__support_ticket_issue_links")

    found = _by_tenant(
        case.rows(
            "SELECT tenant_id, issue_key, toString(last_seen_at) AS last_seen_at"
            " FROM staging.zendesk__support_ticket_issue_links FINAL"
            f" WHERE insight_source_id = '{SOURCE}' AND ticket_id = '1' AND issue_id = '10001'"
        )
    )

    assert found == {
        TENANT: {"issue_key": "MINE-1", "last_seen_at": "2026-01-10 00:00:00.000"},
        OTHER_TENANT: {"issue_key": "THEIRS-1", "last_seen_at": "2026-01-12 00:00:00.000"},
    }, found


CLASSES = {
    "class_support_tickets": "ticket_id = '1'",
    "class_support_interactions": "interaction_id = '1022'",
    "class_support_satisfaction": "rating_id = 'sr-1'",
    "class_support_ticket_field_history": "ticket_id = '1' AND field_id = 'status' AND event_order = 1",
    "class_support_ticket_issue_links": "ticket_id = '1'",
    "class_support_field_definitions": "field_id = '900'",
    "class_support_agents": "agent_id = '5'",
    "class_support_customers": "customer_id = '5'",
}


def test_the_support_classes_keep_one_row_per_tenant(case: Warehouse) -> None:
    _seed(case)
    case.build(" ".join(f"+{name}" for name in CLASSES))

    for name, where in CLASSES.items():
        rows = case.rows(
            f"SELECT tenant_id, unique_key FROM silver.{name} FINAL"
            f" WHERE data_source = 'zendesk' AND insight_source_id = '{SOURCE}' AND {where} ORDER BY tenant_id"
        )
        # User 5 is an agent in one tenant and a customer in the other.
        expected = {"class_support_agents": [TENANT], "class_support_customers": [OTHER_TENANT]}.get(
            name, [OTHER_TENANT, TENANT]
        )
        assert [r["tenant_id"] for r in rows] == expected, f"{name}: {rows}"
        assert all(str(r["unique_key"]).startswith(f"{r['tenant_id']}-{SOURCE}-") for r in rows), f"{name}: {rows}"
