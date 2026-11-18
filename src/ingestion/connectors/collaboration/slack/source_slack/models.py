"""Shapes of what reaches the connector from outside: its config and Slack's answers.

Each model declares only the fields the connector reads. A member row is emitted
whole, so it is never dumped back through `MemberRow`.
"""

from __future__ import annotations

from datetime import date
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, JsonValue, StrictBool, ValidationError

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


class Page(Answer):
    """A Web API answer that continues on the next page while `next_cursor` is not empty."""

    response_metadata: PageMetadata = PageMetadata()


class UsersPage(Page):
    members: tuple[Member, ...] = ()


class Conversation(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1)
    is_im: bool = False
    is_mpim: bool = False
    is_private: bool = False

    @property
    def kind(self) -> str:
        if self.is_im:
            return "im"
        if self.is_mpim:
            return "mpim"
        return "private_channel" if self.is_private else "public_channel"


class ConversationsPage(Page):
    channels: tuple[Conversation, ...] = ()


class File(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str | None = None
    filetype: str | None = None


class Reaction(BaseModel):
    model_config = ConfigDict(frozen=True)

    name: str | None = None
    count: int | None = None
    users: tuple[str, ...] = ()


class Message(BaseModel):
    """A message or a thread reply. `text` is read only for its length and its links."""

    model_config = ConfigDict(frozen=True)

    ts: str = Field(pattern=r"^\d+(\.\d+)?$")
    thread_ts: str | None = None
    user: str | None = None
    bot_id: str | None = None
    subtype: str | None = None
    reply_count: int | None = None
    text: str | None = None
    files: tuple[File, ...] = ()
    attachments: tuple[JsonValue, ...] = ()
    reactions: tuple[Reaction, ...] = ()


class MessagesPage(Page):
    messages: tuple[Message, ...] = ()


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
