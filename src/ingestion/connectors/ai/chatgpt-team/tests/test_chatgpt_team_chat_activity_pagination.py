"""The chat activity walk must reach the end of a day and then stop.

`user_list` pages with a `cursor` and the `query_id` of the first answer. It
ignores a parameter it does not know and answers page one again, with a new
`next_cursor` each time. A walk that sends the wrong parameter never ends, and
nothing in one answer shows that it is a repeat. The mock answers a follow-up
page only when the request carries both values, so a wrong parameter fails the
read instead of looping. A cap on the records of one day bounds a walk that
loops anyway.
"""

from __future__ import annotations

import json

import yaml
from airbyte_cdk.test.entrypoint_wrapper import EntrypointOutput
from config import ACCOUNT_ID, PROXY_URL, ChatGptTeamConfigBuilder
from connector_tests import ANY_QUERY_PARAMS, HttpMocker, HttpRequest, HttpResponse, connector_dir, load_fixture, read_stream
from freezegun import freeze_time

_CONNECTOR = "ai/chatgpt-team"
_STREAM = "chatgpt_team_chat_activity"
_URL = f"{PROXY_URL}/api/accounts/{ACCOUNT_ID}/analytics/user_list"
_DAY = "2026-08-19"
_NOW = f"{_DAY}T11:30:00Z"
_QUERY_ID = "query-a"
_NEXT_CURSOR = "cursor-b"


def _retriever() -> dict:
    manifest = yaml.safe_load((connector_dir(_CONNECTOR) / "connector.yaml").read_text())
    return next(s for s in manifest["streams"] if s.get("name") == _STREAM)["retriever"]


def _page_size() -> int:
    return int(_retriever()["paginator"]["pagination_strategy"]["page_size"])


def _day_cap() -> int:
    return int(_retriever()["pagination_reset"]["limits"]["number_of_records"])


def _emails(prefix: str, count: int) -> list[str]:
    return [f"{prefix}-{i:03d}@example.com" for i in range(count)]


def _page(emails: list[str], next_cursor: str | None, query_id: str | None) -> HttpResponse:
    body = load_fixture(__file__, "chat_activity_page.json", next_cursor=next_cursor, query_id=query_id)
    body["users"] = [load_fixture(__file__, "chat_activity_user.json", email=e) for e in emails]
    return HttpResponse(body=json.dumps(body), status_code=200)


def _params(page_size: int, **follow_up: str) -> dict[str, str]:
    return {
        "page_size": str(page_size),
        "order_by_field": "messages",
        "order_by_direction": "DESC",
        "start_date": _DAY,
        "end_date": _DAY,
        **follow_up,
    }


def _read_raw() -> EntrypointOutput:
    config = ChatGptTeamConfigBuilder().with_start_date(_DAY).build()
    with freeze_time(_NOW):
        return read_stream(_CONNECTOR, _STREAM, config)


def _read(http_mocker: HttpMocker) -> list[str]:
    output = _read_raw()
    assert not output.errors, f"the read failed: {output.errors}"
    return [r.record.data["email"] for r in output.records]


def test_a_follow_up_page_sends_the_cursor_with_the_query_id(http_mocker: HttpMocker) -> None:
    page_size = _page_size()
    first = _emails("first", page_size)
    second = _emails("second", 3)

    http_mocker.get(HttpRequest(_URL, query_params=_params(page_size)), _page(first, _NEXT_CURSOR, _QUERY_ID))
    http_mocker.get(
        HttpRequest(_URL, query_params=_params(page_size, cursor=_NEXT_CURSOR, query_id=_QUERY_ID)),
        _page(second, None, _QUERY_ID),
    )

    emails = _read(http_mocker)

    assert sorted(emails) == sorted(first + second), "the walk did not read each person of the day once"


def test_a_short_page_ends_the_day_even_with_a_next_cursor(http_mocker: HttpMocker) -> None:
    page_size = _page_size()
    only = _emails("only", 3)

    http_mocker.get(HttpRequest(_URL, query_params=_params(page_size)), _page(only, _NEXT_CURSOR, _QUERY_ID))

    emails = _read(http_mocker)

    assert sorted(emails) == sorted(only), "the walk should stop after a short page"


def test_a_next_cursor_without_a_query_id_fails_the_sync(http_mocker: HttpMocker) -> None:
    page_size = _page_size()

    http_mocker.get(
        HttpRequest(_URL, query_params=_params(page_size)), _page(_emails("only", page_size), _NEXT_CURSOR, None)
    )

    output = _read_raw()

    assert output.errors, "a day that cannot continue must fail, not end green after page one"
    assert "without a query_id" in str(output.errors), f"unexpected failure: {output.errors}"


def test_a_walk_that_never_ends_fails_at_the_day_cap(http_mocker: HttpMocker) -> None:
    """The endpoint answers every request with a full page and a next cursor,
    as it does when it ignores the cursor parameters."""
    page_size = _page_size()
    cap = _day_cap()

    http_mocker.get(
        HttpRequest(_URL, query_params=ANY_QUERY_PARAMS), _page(_emails("loop", page_size), _NEXT_CURSOR, _QUERY_ID)
    )

    output = _read_raw()

    assert output.errors, "an endless walk must fail the sync"
    assert len(output.records) <= 2 * cap, f"the walk read {len(output.records)} records past a cap of {cap}"
