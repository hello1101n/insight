"""The plan and the token's scopes decide which streams a check and a sync read.

`requests_mock` raises NoMockAddress on any unregistered URL, so a test that
registers no day file proves the stream was not read.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
import requests
from airbyte_cdk.models import AirbyteErrorTraceMessage, FailureType
from airbyte_cdk.test.entrypoint_wrapper import EntrypointOutput
from airbyte_cdk.utils.traced_exception import AirbyteTracedException
from conftest import CONFIG, billing, billing_refusal, day_url, member_file, refusal, run, slack
from pydantic import ValidationError
from source_slack.client import BILLING_URL, MAX_ANSWER_BYTES
from source_slack.models import Billing
from source_slack.source import SourceSlack

_LOG = logging.getLogger("test")


def _errors(output: EntrypointOutput) -> list[AirbyteErrorTraceMessage]:
    return [e.trace.error for e in output.errors]


@pytest.mark.parametrize(
    ("header", "scopes"),
    [
        ("admin.analytics:read,team.billing:read", {"admin.analytics:read", "team.billing:read"}),
        (" admin.analytics:read , ,team.billing:read,", {"admin.analytics:read", "team.billing:read"}),
        ("", set()),
    ],
)
def test_the_scope_header_parses_into_a_set_of_scopes(header: str, scopes: set[str]) -> None:
    assert Billing.model_validate({"plan": "plus", "scopes": header}).scopes == scopes, f"should parse: {header!r}"


@pytest.mark.parametrize(
    "billing_input", [{"plan": "plus", "scopes": None}, {"plan": "plus"}, {"plan": None, "scopes": ""}]
)
def test_billing_without_a_plan_or_a_scope_header_is_rejected(billing_input: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        Billing.model_validate(billing_input)


@pytest.mark.parametrize("plan", ["plus", "enterprise", "compliance"])
def test_plans_with_member_analytics_read_activity(plan: str) -> None:
    with slack(plan) as http:
        for day in ("2026-10-01", "2026-10-02"):
            http.get(day_url(day), **member_file(day))

        output = run()

    assert output.records, f"should read users_details on {plan}"
    assert http.request_history[0].url == BILLING_URL


@pytest.mark.parametrize("plan", ["free", "std"])
def test_plans_without_member_analytics_never_read_the_activity_file(plan: str) -> None:
    with slack(plan) as http:
        output = run()

    assert not output.errors, f"should succeed on {plan}"
    assert not output.records
    assert [r.url for r in http.request_history] == [BILLING_URL]


@pytest.mark.parametrize("plan", ["free", "std"])
def test_plans_without_member_analytics_need_the_history_scopes(plan: str) -> None:
    with slack(plan, scopes=("team.billing:read", "users:read", "users:read.email")):
        output = run(expecting_exception=True)

    errors = _errors(output)
    assert errors[0].failure_type == FailureType.config_error, f"should be config_error on {plan}"
    assert "channels:history" in errors[0].message and "messages" in errors[0].message


@pytest.mark.parametrize(
    ("plan", "report"),
    [
        ("plus", "Plan Business+ (plus). Streams to read: users_details, users. Missing scopes: none."),
        ("compliance", "Plan Enterprise (compliance). Streams to read: users_details, users. Missing scopes: none."),
        ("free", "Plan Free (free). Streams to read: messages, users. Missing scopes: none."),
        ("std", "Plan Pro (std). Streams to read: messages, users. Missing scopes: none."),
    ],
)
def test_check_reports_the_plan_and_the_streams_to_read(plan: str, report: str) -> None:
    with slack(plan) as http:
        http.get(day_url("2026-10-02"), **member_file("2026-10-02"))

        status = SourceSlack().check(_LOG, CONFIG)

    assert (status.status.value, status.message) == ("SUCCEEDED", report)


@pytest.mark.parametrize(
    ("code", "hint"),
    [
        ("missing_scope", "team.billing:read"),
        ("enterprise_is_restricted", "enterprise_is_restricted"),
        ("invalid_auth", "invalid_auth"),
        ("not_allowed_token_type", "not_allowed_token_type"),
    ],
)
def test_an_unreadable_plan_fails_the_sync_as_a_config_error_naming_the_code(code: str, hint: str) -> None:
    with slack() as http:
        http.post(BILLING_URL, **billing_refusal(code))

        output = run(expecting_exception=True)
        ok, message = SourceSlack().check_connection(_LOG, CONFIG)

    assert not output.records
    errors = _errors(output)
    assert errors and errors[0].failure_type == FailureType.config_error, f"should be config_error: {code}"
    assert code in errors[0].message and hint in errors[0].message
    assert not ok and code in message and hint in message


@pytest.mark.parametrize("code", ["invalid_arguments", "team_added_to_org", "ratelimited"])
def test_a_plan_refusal_that_is_not_a_token_scope_or_plan_code_fails_as_a_system_error(code: str) -> None:
    with slack() as http:
        http.post(BILLING_URL, **billing_refusal(code))

        output = run(expecting_exception=True)

    errors = _errors(output)
    assert errors[0].failure_type == FailureType.system_error, f"should be system_error: {code}"
    assert code in errors[0].message


def test_an_unknown_plan_fails_the_sync_as_a_config_error() -> None:
    with slack("platinum"):
        output = run(expecting_exception=True)

    errors = _errors(output)
    assert errors[0].failure_type == FailureType.config_error
    assert "platinum" in errors[0].message


def test_a_main_stream_without_its_scope_fails_the_sync_naming_the_scope() -> None:
    with slack("plus", scopes=("team.billing:read", "users:read")):
        output = run(expecting_exception=True)
        ok, message = SourceSlack().check_connection(_LOG, CONFIG)

    errors = _errors(output)
    assert errors[0].failure_type == FailureType.config_error
    assert "admin.analytics:read" in errors[0].message
    assert not ok and "admin.analytics:read" in message


def test_an_optional_stream_without_its_scope_is_skipped_with_a_warning() -> None:
    with slack("plus", scopes=("team.billing:read", "admin.analytics:read", "users:read")) as http:
        for day in ("2026-10-01", "2026-10-02"):
            http.get(day_url(day), **member_file(day))

        output = run()
        status = SourceSlack().check(_LOG, CONFIG)

    assert not output.errors
    assert output.records
    warnings = [log.log.message for log in output.logs if log.log.level.value == "WARN"]
    assert any("users" in w and "users:read.email" in w for w in warnings)
    assert status.message == (
        "Plan Business+ (plus). Streams to read: users_details. Missing scopes: users:read.email."
    )


def test_a_temporary_billing_refusal_is_retried(sleeps: list[float]) -> None:
    with slack() as http:
        http.post(BILLING_URL, [{**billing_refusal("ratelimited"), "headers": {"Retry-After": "7"}}, billing("plus")])
        for day in ("2026-10-01", "2026-10-02"):
            http.get(day_url(day), **member_file(day))

        output = run()

    assert output.records
    assert sleeps == [7.0]


@pytest.mark.parametrize(
    ("answer", "kind"),
    [
        ({"json": billing()["json"]}, FailureType.system_error),
        ({"json": {"ok": "yes", "plan": "plus"}, "headers": billing()["headers"]}, FailureType.system_error),
        ({"json": {"ok": True, "plan": 42}, "headers": billing()["headers"]}, FailureType.system_error),
        ({"json": {"ok": True}, "headers": {"x-oauth-scopes": "team.billing:read"}}, FailureType.system_error),
        (
            {"json": {**billing()["json"], "padding": "x" * MAX_ANSWER_BYTES}, "headers": billing()["headers"]},
            FailureType.system_error,
        ),
        ({"text": "<html>"}, FailureType.system_error),
        ({"status_code": 403}, FailureType.system_error),
        ({"exc": requests.ConnectionError("no route")}, FailureType.transient_error),
    ],
)
def test_a_broken_billing_answer_fails_the_sync(answer: dict[str, Any], kind: FailureType) -> None:
    with slack() as http:
        http.post(BILLING_URL, **answer)

        output = run(expecting_exception=True)

    assert not output.records
    error = _errors(output)[0]
    assert error.failure_type == kind, f"should fail as {kind}: {answer}"
    assert "team.billing.info" in error.message, f"should name the billing call: {answer}"


@pytest.mark.parametrize(
    "answer", [billing_refusal("ratelimited"), {"status_code": 503}, {"exc": requests.ConnectionError("no route")}]
)
def test_check_raises_when_slack_fails_rather_than_the_config(answer: dict[str, Any]) -> None:
    with slack() as http:
        http.post(BILLING_URL, **answer)

        with pytest.raises(AirbyteTracedException) as raised:
            SourceSlack().check_connection(_LOG, CONFIG)

    assert raised.value.failure_type != FailureType.config_error, f"should not be config_error: {answer}"


def test_check_names_a_refused_day_on_a_readable_plan() -> None:
    with slack() as http:
        http.get(day_url("2026-10-02"), **refusal("member_analytics_disabled"))

        ok, message = SourceSlack().check_connection(_LOG, CONFIG)

    assert not ok and "member_analytics_disabled" in message
