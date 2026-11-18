"""`messages`: one row per message or thread reply, metadata only (Message activity, Free and Pro).

Each sync reads every conversation the token can see, from `max(slack_start_date,
cursor - 2 days)` to now, one week for each slice, and the replies of each thread
whose parent is in that window. The state `{"date": "YYYY-MM-DD"}` is the last full
UTC day read; it moves after each slice. A message read again replaces its row
through `unique_key`.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator, Mapping, MutableMapping
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from airbyte_cdk.models import SyncMode
from airbyte_cdk.sources.streams import CheckpointMixin, Stream

from source_slack import streams
from source_slack.client import SlackApiError, SlackClient
from source_slack.metadata import message_metadata
from source_slack.models import Conversation, Message, SlackConfig
from source_slack.streams import CURSOR, cursor_from_state, traced

logger = logging.getLogger("airbyte")

LOOKBACK = timedelta(days=2)
SLICE = timedelta(days=7)
# The token cannot read this conversation: the next conversation is read.
SKIPPED_CONVERSATION_ERRORS = frozenset({"channel_not_found", "not_in_channel"})
SKIPPED_THREAD_ERRORS = frozenset({"thread_not_found"})


def _epoch(day: date) -> str:
    return str(int(datetime.combine(day, time(), UTC).timestamp()))


class Messages(Stream, CheckpointMixin):
    primary_key = "unique_key"
    cursor_field = CURSOR
    source_defined_cursor = True
    state_checkpoint_interval = None

    def __init__(self, config: SlackConfig, client: SlackClient) -> None:
        self._client = client
        self._tenant_id = config.insight_tenant_id
        self._source_id = config.insight_source_id
        self._start = config.slack_start_date
        self._cursor: date | None = None
        self._conversations: list[Conversation] | None = None

    @property
    def name(self) -> str:
        return "messages"

    def get_json_schema(self) -> Mapping[str, Any]:
        from source_slack.source import load_stream_schema

        return load_stream_schema(self.name)

    @property
    def state(self) -> MutableMapping[str, Any]:
        return {CURSOR: self._cursor.isoformat()} if self._cursor else {}

    @state.setter
    def state(self, value: Mapping[str, Any]) -> None:
        self._cursor = cursor_from_state(value) if isinstance(value, Mapping) else None

    def stream_slices(
        self, sync_mode: Any = None, cursor_field: Any = None, stream_state: Mapping[str, Any] | None = None
    ) -> Iterable[Mapping[str, Any] | None]:
        if stream_state:
            self.state = stream_state
        first = max(self._start, self._cursor - LOOKBACK) if self._cursor else self._start
        today = streams.today()
        while first + SLICE <= today:
            yield {"oldest": first.isoformat(), "latest": (first + SLICE).isoformat()}
            first += SLICE
        if first <= today:
            yield {"oldest": first.isoformat(), "latest": None}

    def read_records(
        self,
        sync_mode: SyncMode,
        cursor_field: Any = None,
        stream_slice: Mapping[str, Any] | None = None,
        **kwargs: Any,
    ) -> Iterable[Mapping[str, Any]]:
        if not stream_slice:
            return
        oldest = _epoch(date.fromisoformat(stream_slice["oldest"]))
        end = date.fromisoformat(stream_slice["latest"]) if stream_slice["latest"] else None

        for conversation in self._visible_conversations():
            yield from self._conversation(conversation, oldest, _epoch(end) if end else None)

        self._cursor = (end or streams.today()) - timedelta(days=1)

    def _visible_conversations(self) -> list[Conversation]:
        if self._conversations is None:
            with traced("conversations.list"):
                self._conversations = list(self._client.conversations())
        return self._conversations

    def probe(self) -> None:
        """Read the first conversation and its latest message; raise what a sync would."""
        with traced("conversations.list"):
            conversation = next(self._client.conversations(), None)
        if conversation is None:
            return
        records = self._conversation(conversation, _epoch(streams.today()), None)
        next(records, None)
        records.close()

    def _conversation(self, conversation: Conversation, oldest: str, latest: str | None) -> Iterator[dict[str, Any]]:
        with traced("conversations.history"):
            try:
                for message in self._client.history(conversation.id, oldest, latest):
                    yield self._record(conversation, message)
                    if message.reply_count and message.thread_ts == message.ts:
                        yield from self._thread(conversation, message.ts, oldest)
            except SlackApiError as error:
                if error.code not in SKIPPED_CONVERSATION_ERRORS:
                    raise
                logger.warning(
                    "Slack refused %s for conversation %s with %s. The conversation is skipped.",
                    error.method,
                    conversation.id,
                    error.code,
                )

    def _thread(self, conversation: Conversation, thread_ts: str, oldest: str) -> Iterator[dict[str, Any]]:
        with traced("conversations.replies"):
            try:
                for reply in self._client.replies(conversation.id, thread_ts, oldest):
                    if reply.ts != thread_ts:
                        yield self._record(conversation, reply)
            except SlackApiError as error:
                if error.code not in SKIPPED_THREAD_ERRORS:
                    raise
                logger.warning(
                    "Slack refused %s for thread %s in %s with %s. The thread is skipped.",
                    error.method,
                    thread_ts,
                    conversation.id,
                    error.code,
                )

    def _record(self, conversation: Conversation, message: Message) -> dict[str, Any]:
        return {
            **message_metadata(message),
            "channel_id": conversation.id,
            "channel_type": conversation.kind,
            "insight_tenant_id": self._tenant_id,
            "insight_source_id": self._source_id,
            "unique_key": f"{self._tenant_id}-{self._source_id}-{conversation.id}-{message.ts}",
        }
