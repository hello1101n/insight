"""A message becomes counts and IDs; its content never reaches a record."""

from __future__ import annotations

import json

import pytest
from source_slack.metadata import hosts, links, message_day, message_metadata
from source_slack.models import File, Message, Reaction


@pytest.mark.parametrize(
    ("text", "urls"),
    [
        ("no links here", []),
        ("see <https://example.com/a?b=1>", ["https://example.com/a?b=1"]),
        ("see <https://example.com/a|the page>", ["https://example.com/a"]),
        ("<http://example.org|https://example.net/label>", ["http://example.org"]),
        ("bare https://example.com/x and <https://example.org>", ["https://example.org", "https://example.com/x"]),
        ("<@U123> and <#C123|general> and <!here> and <mailto:a@example.com|mail>", []),
        ("ftp://example.com and example.com", []),
        ("<HTTPS://Example.COM/path>", ["HTTPS://Example.COM/path"]),
    ],
)
def test_links_are_absolute_http_urls_and_mentions_are_not(text: str, urls: list[str]) -> None:
    assert sorted(links(text)) == sorted(urls), f"should find {urls} in {text!r}"


@pytest.mark.parametrize(
    ("urls", "names"),
    [
        (
            ["https://Example.com/a", "https://example.com/b", "http://docs.example.org"],
            ["docs.example.org", "example.com"],
        ),
        (["https://user:pw@example.com:8443/x"], ["example.com"]),
        (["https://[::1/broken"], []),
        ([], []),
    ],
)
def test_hosts_are_distinct_lowercase_and_drop_the_path(urls: list[str], names: list[str]) -> None:
    assert hosts(urls) == names, f"should give {names} for {urls}"


@pytest.mark.parametrize(
    ("ts", "day"),
    [("1790812800.000100", "2026-10-01"), ("1790899199.999999", "2026-10-01"), ("1790899200", "2026-10-02")],
)
def test_the_day_of_a_message_is_its_utc_day(ts: str, day: str) -> None:
    assert message_day(ts).isoformat() == day, f"should be {day}: {ts}"


def test_the_metadata_keeps_counts_and_ids_but_no_content() -> None:
    message = Message.model_validate(
        {
            "ts": "1790812800.000100",
            "thread_ts": "1790812800.000100",
            "user": "U1",
            "reply_count": 2,
            "text": "Private words <https://example.com/private/path?q=name|label words> https://docs.example.org/x",
            "blocks": [{"type": "rich_text", "elements": [{"text": "Private words"}]}],
            "files": [
                {"id": "F1", "filetype": "pdf", "name": "salary-review.pdf", "title": "Salary review"},
                {"id": "F2", "filetype": "png", "url_private": "https://files.example.com/F2/secret.png"},
            ],
            "attachments": [{"title": "Preview title", "text": "Preview text"}],
            "reactions": [{"name": "thumbsup", "count": 2, "users": ["U2", "U3"]}],
        }
    )

    metadata = message_metadata(message)

    assert metadata == {
        "ts": "1790812800.000100",
        "date": "2026-10-01",
        "thread_ts": "1790812800.000100",
        "user_id": "U1",
        "bot_id": None,
        "subtype": None,
        "reply_count": 2,
        "reactions": [Reaction(name="thumbsup", count=2, users=("U2", "U3")).model_dump(mode="json")],
        "text_length": len(message.text or ""),
        "link_count": 2,
        "link_hosts": ["docs.example.org", "example.com"],
        "file_ids": ["F1", "F2"],
        "file_types": ["pdf", "png"],
        "file_count": 2,
        "attachment_count": 1,
    }
    dumped = json.dumps(metadata)
    for secret in ("Private words", "private/path", "label words", "salary", "Salary", "secret.png", "Preview"):
        assert secret not in dumped, f"should not keep {secret!r}"


def test_a_file_without_an_id_counts_but_adds_no_id() -> None:
    message = Message(ts="1790812800.000100", files=(File(), File(id="F1", filetype="txt")))

    metadata = message_metadata(message)

    assert (metadata["file_count"], metadata["file_ids"], metadata["file_types"]) == (2, ["F1"], ["txt"])
