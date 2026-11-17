"""Shapes of what reaches the connector from outside: its config and Slack's answers.

Each model declares only the fields the connector reads. A member row is emitted
whole, so it is never dumped back through `MemberRow`.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, StrictBool, ValidationError

NonBlank = Annotated[str, Field(pattern=r"\S")]


class SlackConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    insight_tenant_id: NonBlank
    insight_source_id: NonBlank
    slack_bot_token: NonBlank
    slack_start_date: date


class Refusal(BaseModel):
    """The `{"ok": false, "error": "<code>"}` body Slack sends instead of a file."""

    model_config = ConfigDict(frozen=True)

    ok: StrictBool
    error: str | None = None


class Answer(BaseModel):
    """A Web API JSON answer: `ok` and, on a refusal, the `error` code."""

    model_config = ConfigDict(frozen=True)

    ok: StrictBool
    error: str | None = None


class BillingAnswer(Answer):
    """The `team.billing.info` answer: the plan, or a refusal."""

    plan: str | None = None


class Profile(BaseModel):
    model_config = ConfigDict(frozen=True)

    display_name: str | None = None
    real_name: str | None = None
    email: str | None = None


class Member(BaseModel):
    """One member of a `users.list` page. The connector keeps only these fields."""

    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1)
    real_name: str | None = None
    deleted: bool | None = None
    is_bot: bool | None = None
    is_restricted: bool | None = None
    is_ultra_restricted: bool | None = None
    profile: Profile = Profile()


class PageMetadata(BaseModel):
    model_config = ConfigDict(frozen=True)

    next_cursor: str = ""


class UsersPage(Answer):
    members: tuple[Member, ...] = ()
    response_metadata: PageMetadata = PageMetadata()


def _scope_list(value: object) -> object:
    return frozenset(filter(None, (scope.strip() for scope in value.split(",")))) if isinstance(value, str) else value


class Billing(BaseModel):
    """The plan from `team.billing.info` and the token's scopes from its `x-oauth-scopes` header."""

    model_config = ConfigDict(frozen=True)

    plan: str
    scopes: Annotated[frozenset[str], BeforeValidator(_scope_list)]


class MemberRow(BaseModel):
    model_config = ConfigDict(frozen=True)

    user_id: str = Field(min_length=1)
    date: str | None = None


def describe(error: ValidationError) -> str:
    """Field paths and error types only: the input can be a token or an email address.

    Raise the wrapping error `from None`: the CDK logs and traces the cause, and
    `str(ValidationError)` quotes the input.
    """
    return "; ".join(
        f"{'.'.join(map(str, detail['loc'])) or '<root>'}: {detail['type']}"
        for detail in error.errors(include_input=False)
    )
