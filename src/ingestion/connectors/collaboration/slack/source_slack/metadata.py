"""The metadata of a message: counts and IDs only, never the content.

SAFETY: a record built here holds no text, no file name and no URL path or
query. These can contain names, IDs and other personal data.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from typing import Any
from urllib.parse import urlsplit

from source_slack.models import Message

# Slack writes a link as <url> or <url|label>; a mention is <@U…>, <#C…> or <!…>.
_ENTITY = re.compile(r"<([^<>]*)>")
_URL = re.compile(r"https?://[^\s<>|]+", re.IGNORECASE)


def links(text: str) -> list[str]:
    """Absolute http and https URLs in the text. A label is not a link."""
    found: list[str] = []
    rest: list[str] = []
    cursor = 0
    for entity in _ENTITY.finditer(text):
        rest.append(text[cursor : entity.start()])
        target = entity.group(1).split("|", 1)[0]
        if _URL.fullmatch(target):
            found.append(target)
        cursor = entity.end()
    rest.append(text[cursor:])
    for part in rest:
        found.extend(_URL.findall(part))
    return found


def hosts(urls: list[str]) -> list[str]:
    """The distinct hosts of the URLs, sorted. A URL without a host is left out."""
    names = set()
    for url in urls:
        try:
            host = urlsplit(url).hostname
        except ValueError:
            continue
        if host:
            names.add(host)
    return sorted(names)


def message_day(ts: str) -> date:
    return datetime.fromtimestamp(float(ts), UTC).date()


def message_metadata(message: Message) -> dict[str, Any]:
    text = message.text or ""
    urls = links(text)
    return {
        "ts": message.ts,
        "date": message_day(message.ts).isoformat(),
        "thread_ts": message.thread_ts,
        "user_id": message.user,
        "bot_id": message.bot_id,
        "subtype": message.subtype,
        "reply_count": message.reply_count,
        "reactions": [reaction.model_dump(mode="json") for reaction in message.reactions],
        "text_length": len(text),
        "link_count": len(urls),
        "link_hosts": hosts(urls),
        "file_ids": [file.id for file in message.files if file.id],
        "file_types": [file.filetype for file in message.files if file.filetype],
        "file_count": len(message.files),
        "attachment_count": len(message.attachments),
    }
