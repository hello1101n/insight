"""Mock-server tests for the Zendesk streams: auth, the three pagination
protocols, the whole-object payload, optional products and merge audits."""

from __future__ import annotations

import json

import freezegun
import pytest
from airbyte_cdk.models import SyncMode
from config import BASE_URL, CONNECTOR, NOW, START_EPOCH, ZendeskConfigBuilder, mock_token, ok
from connector_tests import HttpMocker, HttpRequest, HttpResponse, assert_records_conform, read_stream

TICKETS_URL = f"{BASE_URL}/incremental/tickets/cursor.json"
EVENTS_URL = f"{BASE_URL}/incremental/ticket_events.json"


def _ticket(ticket_id: int, updated_at: str) -> dict:
    return {
        "id": ticket_id,
        "updated_at": updated_at,
        "status": "open",
        "custom_fields": [{"id": 900, "value": ["a", "b"]}],
        "metric_set": {"reply_time_in_minutes": {"calendar": 5}},
    }


@freezegun.freeze_time(NOW)
def test_tickets_follow_after_url_until_end_of_stream_and_keep_the_whole_object(http_mocker: HttpMocker) -> None:
    mock_token(http_mocker)
    first = f"{TICKETS_URL}?start_time={START_EPOCH}&include=metric_sets&support_type_scope=all&per_page=1000"
    second = f"{TICKETS_URL}?cursor=c2"
    http_mocker.get(
        HttpRequest(first),
        ok({"tickets": [_ticket(1, "2026-06-10T00:00:00Z")], "after_url": second, "end_of_stream": False}),
    )
    http_mocker.get(
        HttpRequest(second),
        ok(
            {
                "tickets": [_ticket(2, "2026-06-11T00:00:00Z")],
                "after_url": f"{TICKETS_URL}?cursor=c3",
                "end_of_stream": True,
            }
        ),
    )

    output = read_stream(CONNECTOR, "zendesk_tickets", ZendeskConfigBuilder().build(), sync_mode=SyncMode.incremental)

    records = [r.record.data for r in output.records]
    assert [r["id"] for r in records] == [1, 2]
    assert records[0]["unique_key"] == "test-tenant-test-source-1"
    assert json.loads(records[0]["payload_json"])["custom_fields"] == [{"id": 900, "value": ["a", "b"]}]
    assert_records_conform(output.records, CONNECTOR, "zendesk_tickets", strict=False)
    assert output.state_messages, "the cursor must emit state"


@freezegun.freeze_time(NOW)
def test_ticket_events_follow_next_page_until_end_of_stream(http_mocker: HttpMocker) -> None:
    mock_token(http_mocker)
    first = f"{EVENTS_URL}?start_time={START_EPOCH}&include=comment_events"
    second = f"{EVENTS_URL}?start_time=1780400000&include=comment_events"
    event = {
        "id": 10,
        "ticket_id": 1,
        "timestamp": 1780300000,
        "child_events": [{"event_type": "Change", "status": "pending", "previous_value": "open"}],
    }
    http_mocker.get(HttpRequest(first), ok({"ticket_events": [event], "next_page": second, "end_of_stream": False}))
    http_mocker.get(
        HttpRequest(second),
        ok({"ticket_events": [{**event, "id": 11, "timestamp": 1780400001}], "next_page": None, "end_of_stream": True}),
    )

    output = read_stream(
        CONNECTOR, "zendesk_ticket_events", ZendeskConfigBuilder().build(), sync_mode=SyncMode.incremental
    )

    assert [r.record.data["id"] for r in output.records] == [10, 11]
    assert json.loads(output.records[0].record.data["payload_json"])["child_events"][0]["status"] == "pending"


def test_list_streams_follow_after_cursor_until_has_more_is_false(http_mocker: HttpMocker) -> None:
    mock_token(http_mocker)
    http_mocker.get(
        HttpRequest(f"{BASE_URL}/groups", query_params={"page[size]": "100"}),
        ok({"groups": [{"id": 1}], "meta": {"has_more": True, "after_cursor": "g2"}}),
    )
    http_mocker.get(
        HttpRequest(f"{BASE_URL}/groups", query_params={"page[size]": "100", "page[after]": "g2"}),
        ok({"groups": [{"id": 2}], "meta": {"has_more": False, "after_cursor": "g3"}}),
    )

    output = read_stream(CONNECTOR, "zendesk_groups", ZendeskConfigBuilder().build())

    assert [r.record.data["id"] for r in output.records] == [1, 2]


@freezegun.freeze_time(NOW)
def test_an_account_without_survey_csat_yields_an_empty_stream_not_an_error(http_mocker: HttpMocker) -> None:
    mock_token(http_mocker)
    http_mocker.get(
        HttpRequest(
            f"{BASE_URL}/guide/survey_responses",
            query_params={"page[size]": "50", "filter[created_at_start]": "1780272000000"},
        ),
        HttpResponse(body=json.dumps({"errors": [{"title": "Not Found"}]}), status_code=404),
    )

    output = read_stream(
        CONNECTOR, "zendesk_survey_responses", ZendeskConfigBuilder().build(), sync_mode=SyncMode.incremental
    )

    assert output.records == []
    assert output.errors == []


@freezegun.freeze_time(NOW)
def test_merge_audits_keep_only_the_merge_audit_of_tickets_closed_by_merge(http_mocker: HttpMocker) -> None:
    mock_token(http_mocker)
    http_mocker.get(
        HttpRequest(
            f"{BASE_URL}/search/export.json",
            query_params={
                "query": "tags:closed_by_merge updated>=2026-06-01",
                "filter[type]": "ticket",
                "page[size]": "1000",
            },
        ),
        ok({"results": [{"id": 7, "updated_at": "2026-06-20T00:00:00Z"}], "meta": {"has_more": False}}),
    )
    merge = {
        "id": 71,
        "ticket_id": 7,
        "created_at": "2026-06-20T00:00:00Z",
        "via": {"channel": "system", "source": {"rel": "merge", "from": {"ticket_id": 2}}},
    }
    other = {
        "id": 70,
        "ticket_id": 7,
        "created_at": "2026-06-19T00:00:00Z",
        "via": {"channel": "web", "source": {"rel": None}},
    }
    http_mocker.get(HttpRequest(f"{BASE_URL}/tickets/7/audits.json"), ok({"audits": [other, merge], "next_page": None}))

    output = read_stream(
        CONNECTOR, "zendesk_merge_audits", ZendeskConfigBuilder().build(), sync_mode=SyncMode.incremental
    )

    assert [r.record.data["id"] for r in output.records] == [71]
    assert json.loads(output.records[0].record.data["payload_json"])["via"]["source"]["from"]["ticket_id"] == 2


@pytest.mark.parametrize("status", [401, 403])
def test_rejected_credentials_fail_the_sync_instead_of_retrying(http_mocker: HttpMocker, status: int) -> None:
    mock_token(http_mocker)
    http_mocker.get(
        HttpRequest(f"{BASE_URL}/ticket_fields", query_params={"page[size]": "100"}),
        HttpResponse(body=json.dumps({"error": "Forbidden"}), status_code=status),
    )

    output = read_stream(CONNECTOR, "zendesk_ticket_fields", ZendeskConfigBuilder().build(), expecting_exception=True)

    assert output.records == []
    assert any("OAuth client" in (e.trace.error.message or "") for e in output.errors), (
        f"should fail with the auth hint on {status}"
    )
