from __future__ import annotations

import errno
import socket
import ssl
import urllib.error
from collections.abc import Iterator
from contextlib import contextmanager
from http.client import BadStatusLine, IncompleteRead, LineTooLong

from pydantic import BaseModel, ValidationError


class UnreadableResponse(OSError):
    pass


@contextmanager
def response_errors() -> Iterator[None]:
    try:
        yield
    except (BadStatusLine, IncompleteRead, LineTooLong):
        raise UnreadableResponse("The API response is incomplete.") from None


def parse_response[Model: BaseModel](model: type[Model], body: bytes) -> Model:
    try:
        return model.model_validate_json(body)
    except ValidationError as error:
        field_type = error.errors(include_input=False)[0]["type"]
        raise UnreadableResponse(f"The {model.__name__} response has an invalid field: {field_type}.") from None


def connection_error(error: BaseException) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return False
    if isinstance(error, urllib.error.URLError):
        reason = error.reason
        return isinstance(reason, str) or connection_error(reason)
    return isinstance(error, (ConnectionError, TimeoutError, ssl.SSLError, socket.gaierror, UnreadableResponse)) or (
        isinstance(error, OSError) and error.errno in {errno.ENETUNREACH, errno.EHOSTUNREACH, errno.ENETDOWN}
    )


def transient_error(error: BaseException) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code in (408, 429) or 500 <= error.code < 600
    return connection_error(error)
