from __future__ import annotations

import errno
import os
import socket
import ssl
import urllib.error
from collections.abc import Iterator
from contextlib import contextmanager
from http.client import BadStatusLine, IncompleteRead, LineTooLong

from pydantic import BaseModel, ValidationError


class UnreadableResponse(OSError):
    pass


def capacity_check_enabled() -> bool:
    return os.environ.get("AIRBYTE_CAPACITY_CHECK_ENABLED") == "true"


@contextmanager
def response_errors(*, enabled: bool = True) -> Iterator[None]:
    try:
        yield
    except (BadStatusLine, IncompleteRead, LineTooLong):
        if not enabled:
            raise
        raise UnreadableResponse("The API response is incomplete.") from None


def parse_response[Model: BaseModel](model: type[Model], body: bytes, *, enabled: bool = True) -> Model:
    if not enabled:
        return model.model_validate_json(body)
    try:
        return model.model_validate_json(body)
    except ValidationError as error:
        field_type = error.errors(include_input=False)[0]["type"]
        if field_type == "json_invalid":
            raise UnreadableResponse(f"The {model.__name__} response is not valid JSON.") from None
        raise ValueError(f"The {model.__name__} response has an invalid field: {field_type}.") from None


def _connection_error(error: BaseException) -> bool:
    if isinstance(error, (urllib.error.HTTPError, ssl.SSLCertVerificationError)):
        return False
    if isinstance(error, urllib.error.URLError):
        reason = error.reason
        return isinstance(reason, str) or _connection_error(reason)
    return isinstance(error, (ConnectionError, TimeoutError, ssl.SSLError, socket.gaierror, UnreadableResponse)) or (
        isinstance(error, OSError) and error.errno in {errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ENETDOWN}
    )


def transient_error(error: BaseException) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code in (408, 429) or 500 <= error.code < 600
    return _connection_error(error)
