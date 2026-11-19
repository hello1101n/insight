"""`usergroup_members`: the members of each enabled user group, one row per group, member and sync day."""

from __future__ import annotations

import logging
from typing import Any

import pytest
import requests
from airbyte_cdk.models import FailureType, SyncMode
from airbyte_cdk.test.catalog_builder import CatalogBuilder
from airbyte_cdk.test.entrypoint_wrapper import EntrypointOutput, read
from conftest import CONFIG, SCOPES, TODAY, slack
from source_slack.client import USERGROUP_USERS_URL, USERGROUPS_URL
from source_slack.models import Usergroup, UsergroupsAnswer, UsergroupUsersAnswer
from source_slack.source import SourceSlack

_LOG = logging.getLogger("test")
_GROUPS = (
    Usergroup(id="S1", handle="example-team", name="Example Team"),
    Usergroup(id="S2", handle="admins", name="Admins", auto_type="admins"),
)
_MEMBERS = {"S1": ("U1", "U2"), "S2": ("U2",)}


def _run(expecting_exception: bool = False) -> EntrypointOutput:
    catalog = CatalogBuilder().with_stream("usergroup_members", SyncMode.full_refresh).build()
    return read(SourceSlack(), CONFIG, catalog, expecting_exception=expecting_exception)


def _records(output: EntrypointOutput) -> list[dict[str, Any]]:
    return [record.record.data for record in output.records]


def _groups(groups: tuple[Usergroup, ...] = _GROUPS) -> dict[str, Any]:
    return {"json": UsergroupsAnswer(ok=True, usergroups=groups).model_dump(mode="json")}


def _users(users: tuple[str, ...]) -> dict[str, Any]:
    return {"json": UsergroupUsersAnswer(ok=True, users=users).model_dump(mode="json")}


def _refusal(code: str) -> dict[str, Any]:
    return {"json": UsergroupUsersAnswer(ok=False, error=code).model_dump(mode="json", exclude_none=True)}


def _group_url(group: str) -> str:
    return f"{USERGROUP_USERS_URL}?usergroup={group}"


def _serve_members(http: Any) -> None:
    http.get(USERGROUPS_URL, **_groups())
    for group, users in _MEMBERS.items():
        http.get(_group_url(group), **_users(users))


def test_each_member_of_each_group_is_one_row_of_the_sync_day() -> None:
    with slack() as http:
        _serve_members(http)
        output = _run()

    day = TODAY.isoformat()
    assert _records(output) == [
        {
            "date": day,
            "usergroup_id": "S1",
            "usergroup_handle": "example-team",
            "usergroup_name": "Example Team",
            "user_id": "U1",
            "insight_tenant_id": "test-tenant",
            "insight_source_id": "slack-test",
            "unique_key": f"test-tenant-slack-test-S1-U1-{day}",
        },
        {
            "date": day,
            "usergroup_id": "S1",
            "usergroup_handle": "example-team",
            "usergroup_name": "Example Team",
            "user_id": "U2",
            "insight_tenant_id": "test-tenant",
            "insight_source_id": "slack-test",
            "unique_key": f"test-tenant-slack-test-S1-U2-{day}",
        },
        {
            "date": day,
            "usergroup_id": "S2",
            "usergroup_handle": "admins",
            "usergroup_name": "Admins",
            "usergroup_auto_type": "admins",
            "user_id": "U2",
            "insight_tenant_id": "test-tenant",
            "insight_source_id": "slack-test",
            "unique_key": f"test-tenant-slack-test-S2-U2-{day}",
        },
    ]


def test_only_enabled_groups_are_listed() -> None:
    with slack() as http:
        _serve_members(http)
        _run()

    queries = [request.qs for request in http.request_history if request.url.startswith(USERGROUPS_URL)]
    assert queries == [{}], "should not ask for disabled groups or inline member lists"


@pytest.mark.parametrize("plan", ["std", "plus", "enterprise", "compliance"])
def test_paid_plans_read_the_groups(plan: str) -> None:
    with slack(plan) as http:
        _serve_members(http)
        output = _run()

    assert len(output.records) == 3, f"should read groups on {plan}"


def test_the_free_plan_never_asks_for_groups() -> None:
    with slack("free") as http:
        _serve_members(http)
        output = _run()

    assert not output.records and not output.errors
    assert not [r for r in http.request_history if r.url.startswith(USERGROUPS_URL)]


def test_a_token_without_the_groups_scope_skips_the_stream() -> None:
    scopes = tuple(scope for scope in SCOPES if scope != "usergroups:read")
    with slack("plus", scopes=scopes) as http:
        _serve_members(http)
        output = _run()

    assert not output.records and not output.errors
    assert not [r for r in http.request_history if r.url.startswith(USERGROUPS_URL)]


def test_a_group_deleted_during_the_sync_is_skipped() -> None:
    with slack() as http:
        http.get(USERGROUPS_URL, **_groups())
        http.get(_group_url("S1"), **_refusal("no_such_subteam"))
        http.get(_group_url("S2"), **_users(("U2",)))
        output = _run()

    assert [(r["usergroup_id"], r["user_id"]) for r in _records(output)] == [("S2", "U2")]
    assert any("no_such_subteam" in message.log.message for message in output.logs)


@pytest.mark.parametrize(
    ("url", "method"), [(USERGROUPS_URL, "usergroups.list"), (_group_url("S1"), "usergroups.users.list")]
)
@pytest.mark.parametrize(
    ("code", "kind"),
    [
        ("plan_upgrade_required", FailureType.config_error),
        ("missing_scope", FailureType.config_error),
        ("invalid_arguments", FailureType.system_error),
    ],
)
def test_a_refusal_fails_the_sync_naming_the_method_and_the_code(
    url: str, method: str, code: str, kind: FailureType
) -> None:
    with slack() as http:
        _serve_members(http)
        http.get(url, **_refusal(code))
        output = _run(expecting_exception=True)

    error = output.errors[0].trace.error
    assert error.failure_type == kind, f"should fail as {kind}: {method} {code}"
    assert code in error.message and method in error.message


def test_a_temporary_refusal_is_retried(sleeps: list[float]) -> None:
    with slack() as http:
        _serve_members(http)
        http.get(_group_url("S1"), [{**_refusal("ratelimited"), "headers": {"Retry-After": "7"}}, _users(("U1",))])
        output = _run()

    assert len(output.records) == 2
    assert sleeps == [7.0]


@pytest.mark.parametrize(
    ("answer", "kind", "phrase"),
    [
        ({"json": {"ok": True, "usergroups": [{"handle": "no-id"}]}}, FailureType.system_error, "usergroups.0.id"),
        ({"text": "<html>"}, FailureType.system_error, "json_invalid"),
        ({"exc": requests.ConnectionError("no route")}, FailureType.transient_error, "ConnectionError"),
    ],
)
def test_a_broken_group_list_fails_the_sync(answer: dict[str, Any], kind: FailureType, phrase: str) -> None:
    with slack() as http:
        http.get(USERGROUPS_URL, **answer)
        output = _run(expecting_exception=True)

    error = output.errors[0].trace.error
    assert error.failure_type == kind, f"should fail as {kind}: {phrase}"
    assert "usergroups.list" in error.message and phrase in error.message, error.message


def test_a_blank_member_id_fails_the_sync() -> None:
    with slack() as http:
        http.get(USERGROUPS_URL, **_groups())
        http.get(_group_url("S1"), json={"ok": True, "users": [""]})
        output = _run(expecting_exception=True)

    error = output.errors[0].trace.error
    assert error.failure_type == FailureType.system_error
    assert "usergroups.users.list" in error.message and "users.0" in error.message


def test_check_reads_the_group_list() -> None:
    with slack("std") as http:
        http.get(USERGROUPS_URL, **_refusal("not_allowed_token_type"))

        ok, message = SourceSlack().check_connection(_LOG, CONFIG)

    assert not ok and "not_allowed_token_type" in message and "usergroups.list" in message
