"""Review status of a property and the parse of the ``hubspot_property_selection`` config value."""

from __future__ import annotations

import json

import pytest
from airbyte_cdk.models import FailureType
from airbyte_cdk.utils import AirbyteTracedException
from source_hubspot.constants import ALLOWED_PROPERTIES_BY_OBJECT
from source_hubspot.models import PropertyDescriptor
from source_hubspot.money import MONEY_PROPERTY_NAMES
from source_hubspot.selection import (
    ObjectDecisions,
    PropertySelection,
    Selection,
    parse_property_selection,
    selection_json,
    with_unreviewed_ignored,
)

DECISIONS = PropertySelection(
    objects={
        "deals": ObjectDecisions(
            collect=frozenset({"deal_type", "plan_total", "amount"}),
            ignore=frozenset({"internal_notes", "budget_note"}),
        )
    }
)


@pytest.mark.parametrize(
    ("object_type", "descriptor", "expected"),
    [
        ("deals", PropertyDescriptor(name="dealname"), Selection.COLLECTED),
        ("deals", PropertyDescriptor(name="deal_type"), Selection.COLLECTED),
        ("deals", PropertyDescriptor(name="internal_notes"), Selection.IGNORED),
        ("deals", PropertyDescriptor(name="brand_new_field"), Selection.UNREVIEWED),
        ("deals", PropertyDescriptor(name="new_total", showCurrencySymbol=True), Selection.UNREVIEWED),
        ("deals", PropertyDescriptor(name="budget_note", numberDisplayHint="currency"), Selection.FORBIDDEN),
        ("deals", PropertyDescriptor(name="hs_arr"), Selection.FORBIDDEN),
        ("deals", PropertyDescriptor(name="hs_mrr"), Selection.UNREVIEWED),
        ("deals", PropertyDescriptor(name="plan_total", showCurrencySymbol=True), Selection.CONFLICT),
        ("deals", PropertyDescriptor(name="amount"), Selection.CONFLICT),
        ("contacts", PropertyDescriptor(name="deal_type"), Selection.UNREVIEWED),
    ],
)
def test_status_follows_the_decision_and_money_always_wins(object_type, descriptor, expected):
    assert DECISIONS.status(object_type, descriptor) is expected, f"{object_type}.{descriptor.name}"


def test_only_collected_properties_are_requested():
    for status_case in Selection:
        names = {
            Selection.COLLECTED: "deal_type",
            Selection.IGNORED: "internal_notes",
            Selection.UNREVIEWED: "brand_new_field",
            Selection.FORBIDDEN: "hs_arr",
            Selection.CONFLICT: "amount",
        }
        descriptor = PropertyDescriptor(name=names[status_case])
        requested = DECISIONS.is_requested("deals", descriptor)
        assert requested is (status_case is Selection.COLLECTED), f"requested for {status_case}"


def test_curated_list_requests_no_standard_money_property():
    for object_type, names in ALLOWED_PROPERTIES_BY_OBJECT.items():
        requested = {n for n in names if PropertySelection().is_requested(object_type, PropertyDescriptor(name=n))}
        assert not requested & MONEY_PROPERTY_NAMES, f"{object_type} requests money"


@pytest.mark.parametrize("raw", [None, "", "  "])
def test_absent_value_means_no_decisions(raw):
    assert parse_property_selection(raw) == PropertySelection()


def test_value_parses_per_object_type():
    raw = json.dumps({"deals": {"collect": ["deal_type"], "ignore": ["internal_notes"]}})
    parsed = parse_property_selection(raw)
    assert parsed.decisions("deals").collect == frozenset({"deal_type"})
    assert parsed.decisions("deals").ignore == frozenset({"internal_notes"})
    assert parsed.decisions("tickets") == ObjectDecisions()


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        json.dumps(["deals"]),
        json.dumps({"deals": {"collect": ["x"], "ignore": ["x"]}}),
        json.dumps({"invoices": {"collect": ["x"]}}),
        json.dumps({"deals": {"collect": ["x"], "skip": ["y"]}}),
        json.dumps({"deals": {"collect": "x"}}),
    ],
)
def test_invalid_value_is_a_config_error(raw):
    with pytest.raises(AirbyteTracedException) as exc_info:
        parse_property_selection(raw)
    assert exc_info.value.failure_type == FailureType.config_error, f"should reject: {raw!r}"


def test_baseline_ignores_every_unreviewed_property_and_keeps_decisions():
    defined = {
        "deals": (
            PropertyDescriptor(name="dealname"),
            PropertyDescriptor(name="deal_type"),
            PropertyDescriptor(name="internal_notes"),
            PropertyDescriptor(name="new_field"),
            PropertyDescriptor(name="new_total", showCurrencySymbol=True),
        ),
        "tickets": (PropertyDescriptor(name="subject"), PropertyDescriptor(name="ticket_extra")),
    }

    baseline = with_unreviewed_ignored(DECISIONS, defined)

    assert baseline.decisions("deals").collect == DECISIONS.decisions("deals").collect
    assert baseline.decisions("deals").ignore == DECISIONS.decisions("deals").ignore | {"new_field", "new_total"}
    assert baseline.decisions("tickets").ignore == frozenset({"ticket_extra"})
    for object_type, descriptors in defined.items():
        statuses = {baseline.status(object_type, d) for d in descriptors}
        assert Selection.UNREVIEWED not in statuses, f"{object_type} keeps an unreviewed property"


def test_written_value_parses_back_to_the_same_selection():
    assert parse_property_selection(selection_json(DECISIONS)) == DECISIONS
