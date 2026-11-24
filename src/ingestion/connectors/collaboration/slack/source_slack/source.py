"""Slack member analytics, message activity, members list and user groups — Airbyte source connector entry point.

Python CDK rather than a declarative manifest: Slack refuses a day with HTTP 200
and `{"ok": false}`, while a served day is a streamed gzip file. A manifest error
handler can only see the body by reading it, which consumes the stream the gzip
decoder reads next, so a declarative connector either stores the refusal as an
empty record or loses every served day. Here the body is read once and decides.

Each check and each sync first asks Slack for the plan and the token's scopes,
and reads only the streams these permit (`source_slack.plan`).
"""

from __future__ import annotations

import json
import logging
import sys
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

import requests
from airbyte_cdk.models import (
    AirbyteConnectionStatus,
    AirbyteMessage,
    AirbyteStateMessage,
    ConfiguredAirbyteCatalog,
    ConnectorSpecification,
    FailureType,
    Status,
)
from airbyte_cdk.sources import AbstractSource
from airbyte_cdk.sources.streams import Stream
from airbyte_cdk.utils.traced_exception import AirbyteTracedException
from pydantic import ValidationError

from source_slack.client import SlackApiError, SlackClient, SlackResponseError
from source_slack.messages import Messages
from source_slack.models import SlackConfig, describe
from source_slack.plan import BILLING_SCOPE, PLAN_NAMES, Access, access
from source_slack.streams import CONFIG_ERRORS, UsersDetails
from source_slack.usergroups import UsergroupMembers
from source_slack.users import Users

logger = logging.getLogger("airbyte")

_PACKAGE = Path(__file__).parent


def load_stream_schema(name: str) -> Mapping[str, Any]:
    return json.loads((_PACKAGE / "schemas" / f"{name}.json").read_text(encoding="utf-8"))


def _config(config: Mapping[str, Any]) -> SlackConfig:
    try:
        return SlackConfig.model_validate(config)
    except ValidationError as error:
        message = f"Invalid config: {describe(error)}"
        raise AirbyteTracedException(
            message=message, internal_message=message, failure_type=FailureType.config_error
        ) from None


def _client(config: SlackConfig) -> SlackClient:
    return SlackClient(config.slack_user_token)


def _streams(config: SlackConfig) -> list[UsersDetails | Messages | Users | UsergroupMembers]:
    client = _client(config)
    return [
        UsersDetails(config, client),
        Messages(config, client),
        Users(config, client),
        UsergroupMembers(config, client),
    ]


def _access(config: SlackConfig) -> Access:
    """The plan and the streams to read, or the failure that stops the sync."""
    try:
        billing = _client(config).billing()
    except SlackApiError as error:
        message = str(error)
        if error.code == "missing_scope":
            message += f" (the token needs {BILLING_SCOPE})"
        kind = FailureType.config_error if error.code in CONFIG_ERRORS else FailureType.system_error
        raise AirbyteTracedException(message=message, internal_message=message, failure_type=kind) from error
    except SlackResponseError as error:
        raise AirbyteTracedException(
            message=f"Unexpected team.billing.info answer: {error}",
            internal_message=str(error),
            failure_type=FailureType.system_error,
        ) from error
    except requests.RequestException as error:
        raise AirbyteTracedException(
            message=f"team.billing.info kept failing: {type(error).__name__}",
            internal_message=str(error),
            failure_type=FailureType.transient_error,
        ) from error

    found = access(billing)
    for name, scopes in found.lacking_scopes.items():
        logger.warning("Skipping stream %s: missing Slack scope %s", name, ", ".join(scopes))
    if not found.has_main:
        logger.warning("No main stream for the %s plan: member activity is not read", PLAN_NAMES[found.plan])
    return found


class SourceSlack(AbstractSource):
    def spec(self, logger: Any) -> ConnectorSpecification:
        return ConnectorSpecification(**json.loads((_PACKAGE / "spec.json").read_text(encoding="utf-8")))

    def check(self, logger: Any, config: Mapping[str, Any]) -> AirbyteConnectionStatus:
        ok, message = self.check_connection(logger, config)
        return AirbyteConnectionStatus(status=Status.SUCCEEDED if ok else Status.FAILED, message=message)

    def check_connection(self, logger: Any, config: Mapping[str, Any]) -> tuple[bool, Any | None]:
        """Pass with a report of the plan, the streams to read and the missing scopes."""
        try:
            parsed = _config(config)
            found = _access(parsed)
            for stream in _streams(parsed):
                if stream.name in found.streams:
                    stream.probe()
        except AirbyteTracedException as error:
            if error.failure_type != FailureType.config_error:
                raise
            return False, error.message
        return True, found.report()

    def streams(self, config: Mapping[str, Any]) -> list[Stream]:
        return list(_streams(_config(config)))

    def read(
        self,
        logger: logging.Logger,
        config: Mapping[str, Any],
        catalog: ConfiguredAirbyteCatalog,
        state: list[AirbyteStateMessage] | None = None,
    ) -> Iterator[AirbyteMessage]:
        found = _access(_config(config))
        logger.info(found.report())
        selected = [s for s in catalog.streams if s.stream.name in found.streams]
        for configured in catalog.streams:
            name = configured.stream.name
            if name not in found.streams and name not in found.lacking_scopes:
                logger.info("Not reading stream %s on the %s plan", name, PLAN_NAMES[found.plan])
        yield from super().read(logger, config, ConfiguredAirbyteCatalog(streams=selected), state)


def main() -> None:
    from airbyte_cdk.entrypoint import launch

    launch(SourceSlack(), sys.argv[1:])
