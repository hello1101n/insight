"""`usergroup_members`: one row per user group, member and sync day (Pro, Business+ and Enterprise).

Full refresh on each sync, no state. The sync day is part of the key, so the rows
of one day are the membership on that day: a member that leaves a group does not
keep a row on later days. A group that Slack deletes between the two calls is
skipped with a warning.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator, Mapping
from typing import Any

from airbyte_cdk.models import SyncMode
from airbyte_cdk.sources.streams import Stream

from source_slack import streams
from source_slack.client import SlackApiError, SlackClient
from source_slack.models import SlackConfig, Usergroup
from source_slack.streams import traced

logger = logging.getLogger("airbyte")

DELETED_GROUP = "no_such_subteam"


class UsergroupMembers(Stream):
    primary_key = "unique_key"

    def __init__(self, config: SlackConfig, client: SlackClient) -> None:
        self._client = client
        self._tenant_id = config.insight_tenant_id
        self._source_id = config.insight_source_id

    @property
    def name(self) -> str:
        return "usergroup_members"

    def get_json_schema(self) -> Mapping[str, Any]:
        from source_slack.source import load_stream_schema

        return load_stream_schema(self.name)

    def read_records(
        self, sync_mode: SyncMode, cursor_field: Any = None, stream_slice: Any = None, stream_state: Any = None
    ) -> Iterable[Mapping[str, Any]]:
        day = streams.today().isoformat()
        for group in self._groups():
            for user_id in self._members(group):
                yield self._record(group, user_id, day)

    def probe(self) -> None:
        """Read the list of groups; raise what a sync would."""
        self._groups()

    def _groups(self) -> tuple[Usergroup, ...]:
        with traced("usergroups.list"):
            return self._client.usergroups()

    def _members(self, group: Usergroup) -> Iterator[str]:
        with traced("usergroups.users.list"):
            try:
                yield from self._client.usergroup_users(group.id)
            except SlackApiError as error:
                if error.code != DELETED_GROUP:
                    raise
                logger.warning("%s for group %s. The connector reads the next group.", error, group.id)

    def _record(self, group: Usergroup, user_id: str, day: str) -> dict[str, Any]:
        return {
            "date": day,
            "usergroup_id": group.id,
            "usergroup_handle": group.handle,
            "usergroup_name": group.name,
            "usergroup_auto_type": group.auto_type,
            "user_id": user_id,
            "insight_tenant_id": self._tenant_id,
            "insight_source_id": self._source_id,
            "unique_key": f"{self._tenant_id}-{self._source_id}-{group.id}-{user_id}-{day}",
        }
