"""Hubspot api client: check_connection, property discovery, schema generation."""

from __future__ import annotations

import logging

import pytest
import requests
from airbyte_cdk.models import FailureType
from airbyte_cdk.utils import AirbyteTracedException
from source_hubspot.api import Hubspot, _TimeoutSession
from source_hubspot.constants import ALLOWED_PROPERTIES_BY_OBJECT, BASE_URL
from source_hubspot.models import PropertiesPage, PropertyDescriptor
from source_hubspot.selection import ObjectDecisions, PropertySelection
from tests.conftest import FakeHttpClient, FakeResponse, assert_no_leak

PERSONAL = "person@example.com"


def make_client(responses=()):
    hs = Hubspot("pat-test-token")
    hs._http_client = FakeHttpClient(responses)
    return hs


def properties_page(*names):
    return FakeResponse(PropertiesPage(results=[PropertyDescriptor(name=n) for n in names]).model_dump(mode="json"))


class TestTimeoutSession:
    def test_default_timeout_injected(self, monkeypatch):
        captured = {}

        def fake_request(self, method, url, **kwargs):
            captured.update(kwargs)
            return "resp"

        monkeypatch.setattr(requests.Session, "request", fake_request)
        session = _TimeoutSession()
        assert session.request("GET", "https://x") == "resp"
        assert captured["timeout"] == (10, 120)

    def test_explicit_timeout_wins(self, monkeypatch):
        captured = {}
        monkeypatch.setattr(requests.Session, "request", lambda self, method, url, **kw: captured.update(kw))
        _TimeoutSession().request("GET", "https://x", timeout=5)
        assert captured["timeout"] == 5


class TestInit:
    def test_empty_token_rejected(self):
        with pytest.raises(ValueError, match="access_token is required"):
            Hubspot("")

    def test_bearer_header_installed(self):
        hs = Hubspot("pat-test-token")
        assert hs.session.headers["Authorization"] == "Bearer pat-test-token"


class TestCheckConnection:
    def test_success(self):
        hs = make_client([FakeResponse({"results": []})])
        assert hs.check_connection() is None
        call = hs._http_client.calls[0]
        assert call["url"] == f"{BASE_URL}/crm/v3/owners/"
        assert call["params"] == {"limit": 1}

    def test_traced_exception_message_returned(self):
        hs = make_client([AirbyteTracedException(message="bad token")])
        assert hs.check_connection() == "bad token"

    def test_transport_error_wrapped(self):
        hs = make_client([requests.ConnectionError("refused")])
        reason = hs.check_connection()
        assert "connectivity check failed" in reason
        assert "refused" in reason

    def test_non_ok_response_surfaced(self):
        hs = make_client([FakeResponse(status_code=404, text="nope")])
        reason = hs.check_connection()
        assert "HTTP 404" in reason and "nope" in reason


class TestPropertiesFor:
    def test_v3_results_wrapper(self):
        hs = make_client([properties_page("email")])
        props = hs.properties_for("contacts")
        assert props == (PropertyDescriptor(name="email"),)
        assert hs._http_client.calls[0]["url"] == f"{BASE_URL}/crm/v3/properties/contacts"

    def test_cached_per_object(self):
        hs = make_client([properties_page("email")])
        hs.properties_for("contacts")
        hs.properties_for("contacts")  # second call must not hit HTTP
        assert len(hs._http_client.calls) == 1

    def test_v2_bare_list_accepted(self):
        hs = make_client([FakeResponse([PropertyDescriptor(name="email").model_dump(mode="json")])])
        assert hs.properties_for("contacts") == (PropertyDescriptor(name="email"),)

    def test_http_error_is_config_error(self):
        hs = make_client([FakeResponse(status_code=403, text="forbidden")])
        with pytest.raises(AirbyteTracedException) as exc_info:
            hs.properties_for("deals")
        assert exc_info.value.failure_type == FailureType.config_error
        assert "crm.objects" in exc_info.value.message

    def test_non_json_body_is_system_error(self):
        hs = make_client([FakeResponse(text="<html>")])
        with pytest.raises(AirbyteTracedException) as exc_info:
            hs.properties_for("deals")
        assert exc_info.value.failure_type == FailureType.system_error
        assert "json_invalid" in exc_info.value.message

    @pytest.mark.parametrize(
        "payload", [PERSONAL, {"results": PERSONAL}, {"results": [{"name": {"email": PERSONAL}}]}, [[PERSONAL]]]
    )
    def test_unexpected_shape_is_system_error_without_input(self, payload):
        hs = make_client([FakeResponse(payload)])
        with pytest.raises(AirbyteTracedException) as exc_info:
            hs.properties_for("deals")
        error = exc_info.value
        assert error.failure_type == FailureType.system_error, f"should reject: {payload!r}"
        assert "Unexpected HubSpot properties payload shape" in error.message
        assert_no_leak(error, PERSONAL)


def described(name, **flags):
    return PropertyDescriptor(name=name, **flags)


def descriptors_page(*descriptors):
    return FakeResponse(PropertiesPage(results=list(descriptors)).model_dump(mode="json"))


def selecting(object_type="deals", collect=(), ignore=()):
    return PropertySelection(
        objects={object_type: ObjectDecisions(collect=frozenset(collect), ignore=frozenset(ignore))}
    )


class TestPropertySelection:
    def test_curated_and_collect_properties_are_requested(self):
        hs = make_client([properties_page("dealname", "uncurated_std", "my_custom", None)])
        hs.selection = selecting(collect={"my_custom"})
        assert hs.property_names("deals") == ("dealname", "my_custom")

    def test_property_without_a_decision_is_not_requested(self):
        hs = make_client([properties_page("dealname", "new_field")])
        assert hs.property_names("deals") == ("dealname",)

    def test_ignored_property_is_not_requested(self):
        hs = make_client([properties_page("dealname", "notes_field")])
        hs.selection = selecting(ignore={"notes_field"})
        assert hs.property_names("deals") == ("dealname",)

    @pytest.mark.parametrize(
        "money",
        [
            described("amount"),
            described("deal_currency_code"),
            described("hs_exchange_rate"),
            described("my_invoice_total", showCurrencySymbol=True),
            described("my_plan_value", numberDisplayHint="currency"),
        ],
    )
    def test_money_property_is_never_requested_even_when_collected(self, money):
        hs = make_client([descriptors_page(described("dealname"), money)])
        hs.selection = selecting(collect={money.name})
        assert hs.property_names("deals") == ("dealname",), f"should not request: {money!r}"

    def test_collected_property_without_a_currency_flag_is_requested(self):
        plain = described("seats", showCurrencySymbol=False, numberDisplayHint="unformatted")
        hs = make_client([descriptors_page(plain)])
        hs.selection = selecting(collect={"seats"})
        assert hs.property_names("deals") == ("seats",)

    def test_money_names_cover_standard_and_portal_flagged_properties(self):
        hs = make_client(
            [descriptors_page(described("my_invoice_total", showCurrencySymbol=True), described("dealname"))]
        )
        money = hs.money_property_names("deals")
        assert {"amount", "annualrevenue", "my_invoice_total"} <= money
        assert "dealname" not in money

    def test_object_without_curated_properties_requests_nothing(self):
        hs = make_client([properties_page("anything")])
        assert hs.property_names("unknown_object") == ()


class TestGenerateSchema:
    def test_allowlist_is_the_whole_property_column_set(self):
        props = make_client().generate_schema("deals")["properties"]
        expected = {f"properties_{name}" for name in ALLOWED_PROPERTIES_BY_OBJECT["deals"]}
        assert {k for k in props if k.startswith("properties_")} == expected
        assert all(props[k] == {"type": ["string", "null"]} for k in expected)

    def test_schema_needs_no_portal_describe(self):
        hs = make_client()  # no queued responses: any HTTP call raises
        hs.generate_schema("deals")
        assert hs._http_client.calls == []

    def test_base_record_fields_always_present(self):
        props = make_client().generate_schema("leads")["properties"]
        assert props["id"] == {"type": ["string", "null"]}
        assert props["archived"] == {"type": ["boolean", "null"]}
        assert props["archivedAt"]["format"] == "date-time"

    @pytest.mark.parametrize("object_type", ["owners", "unknown_object"])
    def test_empty_allowlist_yields_base_fields_only(self, object_type):
        props = make_client().generate_schema(object_type)["properties"]
        assert not [k for k in props if k.startswith("properties_")], f"object: {object_type}"


class TestProbeAssociationScope:
    def test_success(self):
        hs = make_client([FakeResponse({"status": "COMPLETE", "results": []})])
        assert hs.probe_association_scope() is None
        call = hs._http_client.calls[0]
        assert call["url"] == (f"{BASE_URL}/crm/v4/associations/contacts/companies/batch/read")
        assert call["json"] == {"inputs": [{"id": "1"}]}

    def test_config_error_surfaced(self):
        hs = make_client([AirbyteTracedException(message="missing scope", failure_type=FailureType.config_error)])
        assert hs.probe_association_scope() == "missing scope"

    def test_transient_traced_error_swallowed(self, caplog):
        hs = make_client([AirbyteTracedException(message="flaky", failure_type=FailureType.transient_error)])
        with caplog.at_level(logging.WARNING, logger="airbyte"):
            assert hs.probe_association_scope() is None
        assert "transient error" in caplog.text

    def test_unexpected_error_swallowed(self, caplog):
        hs = make_client([RuntimeError("boom")])
        with caplog.at_level(logging.WARNING, logger="airbyte"):
            assert hs.probe_association_scope() is None
        assert "unexpected error" in caplog.text
