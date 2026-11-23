"""Shared helpers: Slack's two answer shapes and a protocol read through the CDK entrypoint."""

from __future__ import annotations

import gzip
import json
from datetime import date
from pathlib import Path
from typing import Any

import pytest
import requests_mock as rm
from airbyte_cdk.models import (
    AirbyteStateBlob,
    AirbyteStateMessage,
    AirbyteStateType,
    AirbyteStreamState,
    ConfiguredAirbyteCatalog,
    StreamDescriptor,
    SyncMode,
)
from airbyte_cdk.test.catalog_builder import CatalogBuilder
from airbyte_cdk.test.entrypoint_wrapper import EntrypointOutput, read
from source_slack import client as client_module
from source_slack import streams as streams_module
from source_slack.client import API_URL, BILLING_URL, CONVERSATIONS_URL, USERGROUPS_URL, USERS_URL
from source_slack.models import (
    BillingAnswer,
    ConversationsPage,
    Member,
    PageMetadata,
    Profile,
    Refusal,
    UsergroupsAnswer,
    UsersPage,
)
from source_slack.plan import HISTORY_SCOPES
from source_slack.source import SourceSlack

TODAY = date(2026, 10, 4)  # today - 2 days = 2026-10-02

CONFIG = {
    "insight_tenant_id": "test-tenant",
    "insight_source_id": "slack-test",
    "slack_user_token": "xoxp-test-token",
    "slack_start_date": "2026-10-01",
}

_FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Freeze the clock and record every retry wait instead of sleeping."""
    waits: list[float] = []
    monkeypatch.setattr(streams_module, "today", lambda: TODAY)
    monkeypatch.setattr(client_module.time, "sleep", waits.append)
    return waits


SCOPES = (
    "admin.analytics:read",
    "team.billing:read",
    "usergroups:read",
    "users:read",
    "users:read.email",
    *sorted(HISTORY_SCOPES),
)


def billing(plan: str = "plus", scopes: tuple[str, ...] = SCOPES) -> dict[str, Any]:
    answer = BillingAnswer(ok=True, plan=plan).model_dump(mode="json", exclude_none=True)
    return {"json": answer, "headers": {"x-oauth-scopes": ",".join(scopes)}}


def billing_refusal(code: str) -> dict[str, Any]:
    return {"json": BillingAnswer(ok=False, error=code).model_dump(mode="json", exclude_none=True)}


MEMBERS = (
    Member(id="U1", real_name="Ann Example", profile=Profile(display_name="ann", email="ann@example.com")),
    Member(id="U2", is_restricted=True, profile=Profile(real_name="Guest Example", email="guest@example.com")),
    Member(id="B1", is_bot=True, profile=Profile(real_name="Example Bot")),
    Member(id="U3", deleted=True),
)


def users_page(members: tuple[Member, ...] = MEMBERS, next_cursor: str = "") -> dict[str, Any]:
    page = UsersPage(ok=True, members=members, response_metadata=PageMetadata(next_cursor=next_cursor))
    return {"json": page.model_dump(mode="json")}


def slack(plan: str = "plus", scopes: tuple[str, ...] = SCOPES) -> rm.Mocker:
    """A mocked Slack that answers team.billing.info, users.list, an empty conversations.list and no user groups.

    Each test registers the rest.
    """
    http = rm.Mocker()
    http.post(BILLING_URL, **billing(plan, scopes))
    http.get(USERS_URL, **users_page())
    http.get(CONVERSATIONS_URL, json=ConversationsPage(ok=True).model_dump(mode="json"))
    http.get(USERGROUPS_URL, json=UsergroupsAnswer(ok=True).model_dump(mode="json"))
    return http


def member_rows(day: str) -> list[dict[str, Any]]:
    rows = json.loads((_FIXTURES / "member_rows.json").read_text())
    return [{**row, "date": day} for row in rows]


def member_file(day: str) -> dict[str, Any]:
    body = gzip.compress("\n".join(json.dumps(r) for r in member_rows(day)).encode())
    return {"content": body, "status_code": 200, "headers": {"Content-Type": "application/gzip"}}


def refusal(code: str) -> dict[str, Any]:
    return {"json": Refusal(ok=False, error=code).model_dump(mode="json"), "status_code": 200}


def day_url(day: str) -> str:
    return f"{API_URL}?type=member&date={day}"


def catalog(sync_mode: SyncMode = SyncMode.incremental) -> ConfiguredAirbyteCatalog:
    return CatalogBuilder().with_stream("users_details", sync_mode).build()


def stream_state(value: dict[str, Any], name: str = "users_details") -> list[AirbyteStateMessage]:
    return [
        AirbyteStateMessage(
            type=AirbyteStateType.STREAM,
            stream=AirbyteStreamState(
                stream_descriptor=StreamDescriptor(name=name), stream_state=AirbyteStateBlob(**value)
            ),
        )
    ]


def run(
    state: list[AirbyteStateMessage] | None = None,
    expecting_exception: bool = False,
    config: dict[str, Any] | None = None,
) -> EntrypointOutput:
    return read(SourceSlack(), config or CONFIG, catalog(), state=state, expecting_exception=expecting_exception)


def assert_not_echoed(output: EntrypointOutput, secret: str) -> None:
    """The value appears in no error message, error stack trace or log line."""
    texts = [
        text
        for error in output.errors
        for text in (error.trace.error.message, error.trace.error.internal_message, error.trace.error.stack_trace)
    ]
    texts += [message.log.message for message in output.logs]
    assert not [text for text in texts if text and secret in text], f"should not echo {secret!r}"


def last_state(output: EntrypointOutput) -> dict[str, Any]:
    return output.state_messages[-1].state.stream.stream_state.__dict__
