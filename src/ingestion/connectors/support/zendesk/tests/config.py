"""Zendesk connector test config and shared mocks."""

from __future__ import annotations

import json

from connector_tests import ConfigBuilder, HttpRequest, HttpResponse

SUBDOMAIN = "example"
BASE_URL = f"https://{SUBDOMAIN}.zendesk.com/api/v2"
TOKEN_URL = f"https://{SUBDOMAIN}.zendesk.com/oauth/tokens"
CONNECTOR = "support/zendesk"

NOW = "2026-07-01T00:00:00Z"
START_DATE = "2026-06-01"
START_EPOCH = "1780272000"


class ZendeskConfigBuilder(ConfigBuilder):
    def __init__(self) -> None:
        super().__init__()
        self._config.update(
            {
                "zendesk_subdomain": SUBDOMAIN,
                "zendesk_client_id": "test-client",
                "zendesk_secret": "test-secret",
                "zendesk_start_date": START_DATE,
            }
        )


def mock_token(http_mocker) -> None:
    """The form body is matched byte-exact, so this pins the client-credentials grant and the read scope."""
    http_mocker.post(
        HttpRequest(
            TOKEN_URL, body="grant_type=client_credentials&client_id=test-client&client_secret=test-secret&scope=read"
        ),
        HttpResponse(body=json.dumps({"access_token": "test-bearer", "token_type": "bearer", "expires_in": 1800})),
    )


def ok(body: dict) -> HttpResponse:
    return HttpResponse(body=json.dumps(body), status_code=200)
