"""Spec and connection check."""

from __future__ import annotations

import logging
from typing import Any

import pytest
from airbyte_cdk.models import FailureType
from airbyte_cdk.utils.traced_exception import AirbyteTracedException
from conftest import CONFIG, day_url, member_file, refusal, slack
from source_slack.source import SourceSlack

_LOG = logging.getLogger("test")
REPORT = "Plan Business+ (plus). Streams to read: users_details. Missing scopes: none."


def test_spec_requires_the_insight_identity_and_the_token() -> None:
    spec = SourceSlack().spec(_LOG).connectionSpecification

    assert set(spec["required"]) == {"insight_tenant_id", "insight_source_id", "slack_bot_token", "slack_start_date"}
    assert spec["properties"]["slack_bot_token"]["airbyte_secret"] is True


def test_check_passes_when_slack_serves_the_latest_day() -> None:
    with slack() as http:
        http.get(day_url("2026-10-02"), **member_file("2026-10-02"))

        assert SourceSlack().check_connection(_LOG, CONFIG) == (True, REPORT)


def test_check_passes_when_the_latest_day_is_not_published_yet() -> None:
    with slack() as http:
        http.get(day_url("2026-10-02"), **refusal("file_not_yet_available"))

        assert SourceSlack().check_connection(_LOG, CONFIG) == (True, REPORT)


def test_check_names_slacks_refusal() -> None:
    with slack() as http:
        http.get(day_url("2026-10-02"), **refusal("not_allowed_token_type"))

        ok, message = SourceSlack().check_connection(_LOG, CONFIG)

    assert not ok
    assert "not_allowed_token_type" in message


def test_check_reports_an_unreachable_api() -> None:
    import requests

    with slack() as http:
        http.get(day_url("2026-10-02"), exc=requests.ConnectionError("no route"))

        with pytest.raises(AirbyteTracedException) as raised:
            SourceSlack().check_connection(_LOG, CONFIG)

    assert raised.value.failure_type == FailureType.transient_error


@pytest.mark.parametrize(
    ("answer", "kind"),
    [
        ({"status_code": 503}, FailureType.system_error),
        (refusal("service_unavailable"), FailureType.system_error),
        (refusal("file_not_found"), FailureType.system_error),
    ],
)
def test_check_raises_when_slack_fails_rather_than_the_config(answer: dict[str, Any], kind: FailureType) -> None:
    with slack() as http:
        http.get(day_url("2026-10-02"), **answer)

        with pytest.raises(AirbyteTracedException) as raised:
            SourceSlack().check_connection(_LOG, CONFIG)

    assert raised.value.failure_type == kind, f"should fail as {kind}: {answer}"


@pytest.mark.parametrize("field", ["insight_tenant_id", "insight_source_id", "slack_bot_token", "slack_start_date"])
def test_check_rejects_an_empty_required_field(field: str) -> None:
    ok, message = SourceSlack().check_connection(_LOG, {**CONFIG, field: " "})

    assert not ok
    assert field in message


@pytest.mark.parametrize(("field", "value"), [("slack_start_date", "01/10/2026"), ("slack_bot_token", 4242424242)])
def test_check_names_a_malformed_field_without_quoting_its_value(field: str, value: object) -> None:
    ok, message = SourceSlack().check_connection(_LOG, {**CONFIG, field: value})

    assert not ok
    assert field in message
    assert str(value) not in message, f"should not quote: {value!r}"


def test_check_names_a_missing_field() -> None:
    config = {key: value for key, value in CONFIG.items() if key != "slack_bot_token"}

    ok, message = SourceSlack().check_connection(_LOG, config)

    assert not ok
    assert "slack_bot_token: missing" in message
