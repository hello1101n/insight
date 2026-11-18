"""`users`: every page of users.list, reduced to the fields Insight keeps."""

from __future__ import annotations

import logging
from typing import Any

import pytest
import requests
from airbyte_cdk.models import FailureType, SyncMode
from airbyte_cdk.test.catalog_builder import CatalogBuilder
from airbyte_cdk.test.entrypoint_wrapper import EntrypointOutput, read
from conftest import CONFIG, MEMBERS, assert_not_echoed, day_url, member_file, slack, users_page
from source_slack.client import MAX_PAGE_BYTES, USERS_URL
from source_slack.models import Member, Profile, UsersPage
from source_slack.source import SourceSlack

_LOG = logging.getLogger("test")
_KEPT = {
    "unique_key",
    "insight_tenant_id",
    "insight_source_id",
    "user_id",
    "real_name",
    "display_name",
    "deleted",
    "email",
    "is_restricted",
    "is_ultra_restricted",
    "is_bot",
}


def _run(expecting_exception: bool = False) -> EntrypointOutput:
    catalog = CatalogBuilder().with_stream("users", SyncMode.full_refresh).build()
    return read(SourceSlack(), CONFIG, catalog, expecting_exception=expecting_exception)


def _records(output: EntrypointOutput) -> list[dict[str, Any]]:
    return [record.record.data for record in output.records]


def _refusal(code: str) -> dict[str, Any]:
    return {"json": UsersPage(ok=False, error=code).model_dump(mode="json", exclude_none=True)}


@pytest.mark.parametrize("plan", ["free", "std", "plus", "enterprise", "compliance"])
def test_every_plan_reads_the_members(plan: str) -> None:
    with slack(plan):
        output = _run()

    assert [r["user_id"] for r in _records(output)] == [m.id for m in MEMBERS], f"should read users on {plan}"


def test_a_member_keeps_only_the_insight_fields() -> None:
    profile = {"display_name": "ann", "email": "ann@example.com", "phone": "+1 555 0100", "title": "Example title"}
    raw = {"id": "U1", "real_name": "Ann Example", "tz": "UTC", "is_admin": True, "profile": profile}

    with slack() as http:
        http.get(USERS_URL, json={"ok": True, "members": [raw]})
        output = _run()

    assert _records(output) == [
        {
            "user_id": "U1",
            "real_name": "Ann Example",
            "display_name": "ann",
            "email": "ann@example.com",
            "insight_tenant_id": "test-tenant",
            "insight_source_id": "slack-test",
            "unique_key": "test-tenant-slack-test-U1",
        }
    ]


def test_the_full_name_falls_back_to_the_profile() -> None:
    with slack():
        output = _run()

    names = {r["user_id"]: r.get("real_name") for r in _records(output)}
    assert names["U2"] == "Guest Example"
    assert all(set(r) <= _KEPT for r in _records(output))


def test_all_pages_are_read_in_order() -> None:
    first = (Member(id="U1", profile=Profile(email="ann@example.com")),)
    second = (Member(id="U2"),)

    with slack() as http:
        http.get(USERS_URL, [users_page(first, next_cursor="page-2"), users_page(second)])
        output = _run()

    assert [r["user_id"] for r in _records(output)] == ["U1", "U2"]
    queries = [request.qs for request in http.request_history if request.url.startswith(USERS_URL)]
    assert queries == [{"limit": ["200"]}, {"limit": ["200"], "cursor": ["page-2"]}]


def test_a_cursor_that_repeats_fails_instead_of_looping() -> None:
    with slack() as http:
        http.get(USERS_URL, [users_page(next_cursor="a"), users_page(next_cursor="b"), users_page(next_cursor="a")])
        output = _run(expecting_exception=True)

    error = output.errors[0].trace.error
    assert error.failure_type == FailureType.system_error
    assert "users.list" in error.message


@pytest.mark.parametrize(
    ("code", "kind"),
    [
        ("missing_scope", FailureType.config_error),
        ("invalid_auth", FailureType.config_error),
        ("enterprise_is_restricted", FailureType.config_error),
        ("invalid_cursor", FailureType.system_error),
    ],
)
def test_a_refused_page_fails_the_sync_naming_the_code(code: str, kind: FailureType) -> None:
    with slack() as http:
        http.get(USERS_URL, **_refusal(code))
        output = _run(expecting_exception=True)

    error = output.errors[0].trace.error
    assert error.failure_type == kind, f"should fail as {kind}: {code}"
    assert code in error.message and "users.list" in error.message


def test_a_temporary_refusal_is_retried(sleeps: list[float]) -> None:
    with slack() as http:
        http.get(USERS_URL, [{**_refusal("ratelimited"), "headers": {"Retry-After": "3"}}, users_page()])
        output = _run()

    assert len(output.records) == len(MEMBERS)
    assert sleeps == [3.0]


@pytest.mark.parametrize(
    ("answer", "kind", "phrase"),
    [
        (
            {"json": {"ok": True, "members": [{"real_name": "No Id", "profile": {"email": "noid@example.com"}}]}},
            FailureType.system_error,
            "members.0.id: missing",
        ),
        (
            {"json": {"ok": True, "members": [{"id": "U1", "padding": "x" * MAX_PAGE_BYTES}]}},
            FailureType.system_error,
            f"exceeds {MAX_PAGE_BYTES} bytes",
        ),
        ({"text": "<html>"}, FailureType.system_error, "json_invalid"),
        ({"status_code": 403}, FailureType.system_error, "HTTP 403"),
        ({"exc": requests.ConnectionError("no route")}, FailureType.transient_error, "ConnectionError"),
    ],
)
def test_a_broken_page_fails_the_sync(answer: dict[str, Any], kind: FailureType, phrase: str) -> None:
    with slack() as http:
        http.get(USERS_URL, **answer)
        output = _run(expecting_exception=True)

    error = output.errors[0].trace.error
    assert error.failure_type == kind, f"should fail as {kind}: {phrase}"
    assert "users.list" in error.message and phrase in error.message, f"should name {phrase!r}: {error.message}"
    assert_not_echoed(output, "noid@example.com")


def test_check_fails_when_users_list_is_refused_for_the_token() -> None:
    with slack("std") as http:
        http.get(USERS_URL, **_refusal("not_allowed_token_type"))

        ok, message = SourceSlack().check_connection(_LOG, CONFIG)

    assert not ok and "not_allowed_token_type" in message


def test_a_token_without_the_email_scope_skips_the_members() -> None:
    with slack("plus", scopes=("team.billing:read", "admin.analytics:read", "users:read")) as http:
        http.get(day_url("2026-10-02"), **member_file("2026-10-02"))
        output = _run()
        status = SourceSlack().check(_LOG, CONFIG)

    assert not output.errors and not output.records
    assert not [r for r in http.request_history if r.url.startswith(USERS_URL)]
    assert status.message == "Plan Business+ (plus). Streams to read: users_details. Missing scopes: users:read.email."
