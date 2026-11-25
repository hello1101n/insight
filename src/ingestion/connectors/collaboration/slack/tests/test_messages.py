"""`messages`: every conversation the token can see, metadata only, on Free and Pro."""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest
import requests
from airbyte_cdk.models import AirbyteStateMessage, FailureType, SyncMode
from airbyte_cdk.test.catalog_builder import CatalogBuilder
from airbyte_cdk.test.entrypoint_wrapper import EntrypointOutput, read
from conftest import CONFIG, assert_not_echoed, last_state, slack, stream_state
from source_slack.client import CONVERSATIONS_URL, HISTORY_URL, REPLIES_URL
from source_slack.models import Conversation, ConversationsPage, Message, MessagesPage, PageMetadata
from source_slack.source import SourceSlack

_LOG = logging.getLogger("test")

OCT_1 = "1790812800"  # 2026-10-01T00:00:00Z
SEP_29 = "1790640000"  # 2026-09-29T00:00:00Z

CONVERSATIONS = (
    Conversation(id="C1"),
    Conversation(id="G1", is_private=True),
    Conversation(id="D1", is_im=True),
    Conversation(id="M1", is_mpim=True, is_private=True),
)


def _run(state: list[AirbyteStateMessage] | None = None, expecting_exception: bool = False) -> EntrypointOutput:
    catalog = CatalogBuilder().with_stream("messages", SyncMode.incremental).build()
    return read(SourceSlack(), CONFIG, catalog, state=state, expecting_exception=expecting_exception)


def _records(output: EntrypointOutput) -> list[dict[str, Any]]:
    return [record.record.data for record in output.records]


def _page(messages: tuple[Message, ...] = (), next_cursor: str = "") -> dict[str, Any]:
    page = MessagesPage(ok=True, messages=messages, response_metadata=PageMetadata(next_cursor=next_cursor))
    return {"json": page.model_dump(mode="json")}


def _refusal(code: str) -> dict[str, Any]:
    return {"json": MessagesPage(ok=False, error=code).model_dump(mode="json", exclude_none=True)}


def _conversations(*conversations: Conversation) -> dict[str, Any]:
    return {"json": ConversationsPage(ok=True, channels=conversations).model_dump(mode="json")}


def _history(http: Any, channel: str, answer: dict[str, Any]) -> None:
    http.get(f"{HISTORY_URL}?channel={channel}", **answer)


def _queries(http: Any, url: str) -> list[dict[str, list[str]]]:
    """Query strings as requests_mock gives them: lowercased."""
    return [request.qs for request in http.request_history if request.url.startswith(url)]


def test_each_conversation_gives_one_row_per_message_with_its_type() -> None:
    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(*CONVERSATIONS))
        for conversation in CONVERSATIONS:
            _history(http, conversation.id, _page((Message(ts="1790812900.000100", user="U1"),)))

        output = _run()

    assert {(r["channel_id"], r["channel_type"]) for r in _records(output)} == {
        ("C1", "public_channel"),
        ("G1", "private_channel"),
        ("D1", "im"),
        ("M1", "mpim"),
    }
    record = _records(output)[0]
    assert record["unique_key"] == "test-tenant-slack-test-C1-1790812900.000100"
    assert (record["date"], record["user_id"]) == ("2026-10-01", "U1")
    assert _queries(http, CONVERSATIONS_URL)[0]["types"] == ["public_channel,private_channel,mpim,im"]


def test_the_first_sync_starts_at_the_start_date_and_saves_yesterday() -> None:
    with slack("free") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        _history(http, "C1", _page())

        output = _run()

    assert _queries(http, HISTORY_URL)[0]["oldest"] == [OCT_1]
    assert last_state(output) == {"date": "2026-10-03"}


@pytest.mark.parametrize(
    ("cursor", "oldest"), [("2026-10-01", OCT_1), ("2026-10-03", OCT_1), ("2026-10-04", "1790899200")]
)
def test_a_later_sync_reads_the_cursor_day_and_two_days_before_it(cursor: str, oldest: str) -> None:
    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        _history(http, "C1", _page())

        _run(state=stream_state({"date": cursor}, "messages"))

    assert _queries(http, HISTORY_URL)[0]["oldest"] == [oldest], f"should start at {oldest} for {cursor}"


def test_a_sync_before_the_start_date_reads_nothing() -> None:
    with slack("std") as http:
        output = read(
            SourceSlack(),
            {**CONFIG, "slack_start_date": "2026-11-01"},
            CatalogBuilder().with_stream("messages", SyncMode.incremental).build(),
        )

    assert not output.errors and not output.records
    assert not _queries(http, CONVERSATIONS_URL)


def test_the_replies_of_a_thread_are_read_without_the_parent_again() -> None:
    parent = Message(ts="1790812900.000100", thread_ts="1790812900.000100", user="U1", reply_count=2)
    reply = Message(ts="1790813000.000200", thread_ts="1790812900.000100", user="U2")
    late_reply = Message(ts="1790813100.000300", thread_ts="1790812900.000100", user="U3")

    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        _history(http, "C1", _page((parent, Message(ts="1790812950.000100", user="U4"))))
        http.get(REPLIES_URL, [_page((parent, reply), next_cursor="next"), _page((late_reply,))])

        output = _run()

    assert [r["ts"] for r in _records(output)] == [parent.ts, reply.ts, late_reply.ts, "1790812950.000100"]
    queries = _queries(http, REPLIES_URL)
    assert queries[0] == {"channel": ["c1"], "ts": [parent.ts], "oldest": [OCT_1], "limit": ["100"]}
    assert queries[1]["cursor"] == ["next"]


def test_no_message_content_reaches_a_record() -> None:
    raw = {
        "ts": "1790812900.000100",
        "thread_ts": "1790812900.000100",
        "reply_count": 1,
        "user": "U1",
        "text": "Confidential words <https://example.com/private?q=name|label words>",
        "blocks": [{"type": "rich_text", "elements": [{"text": "Confidential words"}]}],
        "files": [{"id": "F1", "filetype": "pdf", "name": "plan-confidential.pdf", "preview": "Confidential preview"}],
        "attachments": [{"title": "Confidential attachment"}],
    }

    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        _history(http, "C1", {"json": {"ok": True, "messages": [raw]}})
        http.get(REPLIES_URL, json={"ok": True, "messages": [raw, {**raw, "ts": "1790813000.000200"}]})

        output = _run()

    records = _records(output)
    assert [r["ts"] for r in records] == ["1790812900.000100", "1790813000.000200"], "should read the reply too"
    for record in records:
        assert "confidential" not in json.dumps(record).lower()
        assert not {"text", "blocks", "files", "attachments"} & set(record)
        assert (record["link_count"], record["link_hosts"], record["file_ids"]) == (1, ["example.com"], ["F1"])


@pytest.mark.parametrize("code", ["not_in_channel", "channel_not_found"])
def test_a_conversation_the_token_cannot_read_is_skipped_with_a_warning(code: str) -> None:
    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1"), Conversation(id="C2")))
        _history(http, "C1", _refusal(code))
        _history(http, "C2", _page((Message(ts="1790812900.000100", user="U1"),)))

        output = _run()

    assert not output.errors
    assert [r["channel_id"] for r in _records(output)] == ["C2"]
    warnings = [log.log.message for log in output.logs if log.log.level.value == "WARN"]
    assert any("C1" in w and code in w for w in warnings), f"should warn about {code}"


def test_a_thread_slack_cannot_find_is_skipped() -> None:
    parent = Message(ts="1790812900.000100", thread_ts="1790812900.000100", user="U1", reply_count=1)

    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        _history(http, "C1", _page((parent,)))
        http.get(REPLIES_URL, **_refusal("thread_not_found"))

        output = _run()

    assert not output.errors
    assert [r["ts"] for r in _records(output)] == [parent.ts]


@pytest.mark.parametrize(
    ("url", "answer", "kind", "phrase"),
    [
        (HISTORY_URL, _refusal("missing_scope"), FailureType.config_error, "missing_scope"),
        (HISTORY_URL, _refusal("invalid_cursor"), FailureType.system_error, "invalid_cursor"),
        (CONVERSATIONS_URL, _refusal("invalid_auth"), FailureType.config_error, "invalid_auth"),
        (REPLIES_URL, _refusal("not_authed"), FailureType.config_error, "not_authed"),
        (
            HISTORY_URL,
            {"json": {"ok": True, "messages": [{"user": "U1", "text": "Words of nobody@example.com"}]}},
            FailureType.system_error,
            "messages.0.ts: missing",
        ),
        (HISTORY_URL, {"status_code": 403}, FailureType.system_error, "HTTP 403"),
        (HISTORY_URL, {"exc": requests.ConnectionError("no route")}, FailureType.transient_error, "ConnectionError"),
    ],
)
def test_a_failed_call_fails_the_sync_naming_the_method(
    url: str, answer: dict[str, Any], kind: FailureType, phrase: str
) -> None:
    parent = Message(ts="1790812900.000100", thread_ts="1790812900.000100", user="U1", reply_count=1)
    method = url.rsplit("/", 1)[-1]

    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        _history(http, "C1", _page((parent,)))
        http.get(url, **answer)

        output = _run(expecting_exception=True)

    error = output.errors[0].trace.error
    assert error.failure_type == kind, f"should fail as {kind}: {phrase}"
    assert method in error.message and phrase in error.message, f"should name {method} and {phrase}: {error.message}"
    assert_not_echoed(output, "nobody@example.com")


def _states(output: EntrypointOutput) -> list[dict[str, Any]]:
    return [m.state.stream.stream_state.__dict__ for m in output.state_messages]


def test_a_sync_that_fails_after_some_records_keeps_the_previous_state() -> None:
    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1"), Conversation(id="C2")))
        _history(http, "C1", _page((Message(ts="1790812900.000100", user="U1"),)))
        _history(http, "C2", _refusal("missing_scope"))

        output = _run(state=stream_state({"date": "2026-10-02"}, "messages"), expecting_exception=True)

    assert [r["channel_id"] for r in _records(output)] == ["C1"]
    assert output.errors
    assert all(state == {"date": "2026-10-02"} for state in _states(output)), _states(output)


def test_a_long_window_is_read_one_week_at_a_time_with_a_checkpoint_after_each() -> None:
    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        _history(http, "C1", _page())

        output = read(
            SourceSlack(),
            {**CONFIG, "slack_start_date": "2026-09-15"},
            CatalogBuilder().with_stream("messages", SyncMode.incremental).build(),
        )

    assert not output.errors
    windows = [(q["oldest"], q.get("latest")) for q in _queries(http, HISTORY_URL)]
    assert windows == [(["1789430400"], ["1790035200"]), (["1790035200"], ["1790640000"]), (["1790640000"], None)]
    assert _states(output) == [{"date": "2026-09-21"}, {"date": "2026-09-28"}, {"date": "2026-10-03"}]
    assert len(_queries(http, CONVERSATIONS_URL)) == 1, "should list the conversations once for each sync"


def test_a_failure_in_a_later_week_keeps_the_checkpoint_of_the_earlier_weeks() -> None:
    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        http.get(f"{HISTORY_URL}?channel=C1", [_page(), _refusal("missing_scope")])

        output = read(
            SourceSlack(),
            {**CONFIG, "slack_start_date": "2026-09-15"},
            CatalogBuilder().with_stream("messages", SyncMode.incremental).build(),
            expecting_exception=True,
        )

    assert output.errors
    assert _states(output)[-1] == {"date": "2026-09-21"}


@pytest.mark.parametrize("plan", ["free", "std"])
def test_check_on_free_and_pro_reads_the_first_conversation(plan: str) -> None:
    with slack(plan) as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        _history(http, "C1", _page((Message(ts="1791072100.000100", user="U1"),)))

        ok, message = SourceSlack().check_connection(_LOG, CONFIG)

    assert ok, message
    assert "Streams to read: messages, users" in message
    assert _queries(http, HISTORY_URL)[0]["oldest"] == ["1791072000"]


def test_check_fails_when_the_history_is_refused_for_the_token() -> None:
    with slack("std") as http:
        http.get(CONVERSATIONS_URL, **_conversations(Conversation(id="C1")))
        _history(http, "C1", _refusal("missing_scope"))

        ok, message = SourceSlack().check_connection(_LOG, CONFIG)

    assert not ok and "missing_scope" in message


@pytest.mark.parametrize("plan", ["plus", "enterprise", "compliance"])
def test_plans_with_member_analytics_never_read_the_history(plan: str) -> None:
    with slack(plan) as http:
        output = _run()

    assert not output.errors and not output.records
    assert not _queries(http, CONVERSATIONS_URL)
