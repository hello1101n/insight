"""`users`: one row per member from `users.list`, with only the fields Insight uses.

Full refresh on each sync, no state. The connector drops all other profile fields
(phone, title, photo, status) before bronze.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from typing import Any

import requests
from airbyte_cdk.models import FailureType, SyncMode
from airbyte_cdk.sources.streams import Stream
from airbyte_cdk.utils.traced_exception import AirbyteTracedException

from source_slack.client import SlackApiError, SlackClient, SlackResponseError
from source_slack.models import Member, SlackConfig
from source_slack.streams import failure

METHOD = "users.list"


class Users(Stream):
    primary_key = "unique_key"

    def __init__(self, config: SlackConfig, client: SlackClient) -> None:
        self._client = client
        self._tenant_id = config.insight_tenant_id
        self._source_id = config.insight_source_id

    @property
    def name(self) -> str:
        return "users"

    def get_json_schema(self) -> Mapping[str, Any]:
        from source_slack.source import load_stream_schema

        return load_stream_schema(self.name)

    def read_records(
        self, sync_mode: SyncMode, cursor_field: Any = None, stream_slice: Any = None, stream_state: Any = None
    ) -> Iterable[Mapping[str, Any]]:
        for member in self._members():
            yield self._record(member)

    def probe(self) -> None:
        """Read the first member; raise what a sync would."""
        members = self._members()
        next(members, None)
        members.close()

    def _members(self) -> Iterator[Member]:
        try:
            yield from self._client.members()
        except SlackApiError as error:
            raise failure(error) from error
        except SlackResponseError as error:
            raise AirbyteTracedException(
                message=f"Unexpected {METHOD} answer: {error}",
                internal_message=str(error),
                failure_type=FailureType.system_error,
            ) from error
        except requests.RequestException as error:
            raise AirbyteTracedException(
                message=f"{METHOD} kept failing: {type(error).__name__}",
                internal_message=str(error),
                failure_type=FailureType.transient_error,
            ) from error

    def _record(self, member: Member) -> dict[str, Any]:
        return {
            "user_id": member.id,
            "real_name": member.real_name or member.profile.real_name,
            "display_name": member.profile.display_name,
            "deleted": member.deleted,
            "email": member.profile.email,
            "is_restricted": member.is_restricted,
            "is_ultra_restricted": member.is_ultra_restricted,
            "is_bot": member.is_bot,
            "insight_tenant_id": self._tenant_id,
            "insight_source_id": self._source_id,
            "unique_key": f"{self._tenant_id}-{self._source_id}-{member.id}",
        }
