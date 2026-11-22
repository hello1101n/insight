from __future__ import annotations

import os
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest
from insight_stand import (
    ApiClient,
    ApiResponse,
    JsonValue,
    Manifest,
    PersonaSession,
    authenticator_path,
)
from insight_stand.stand import candidate_env_files, parse_env_file

from .. import scratch
from ..schemas import CreatedSqlToken, ProblemDocument, SqlTokenListResponse

_REPO_ROOT = Path(__file__).resolve().parents[4]
TOKENS = authenticator_path("/v1/sql-tokens")
SQL_QUERY = "/api/sql/query"
READ_ONLY_QUERY: dict[str, JsonValue] = {"sql": "SELECT 1 AS one"}
REVOCATION_DEADLINE_S = 35.0
UNKNOWN_TOKEN = "isql_" + "A" * 43


def _create_body(
    person_id: str, label: str, lifetime_days: int | None = None
) -> dict[str, JsonValue]:
    body: dict[str, JsonValue] = {"person_id": person_id, "label": label}
    if lifetime_days is not None:
        body["lifetime_days"] = lifetime_days
    return body


def _listed(session: PersonaSession) -> SqlTokenListResponse:
    response = session.client.get(TOKENS)
    assert response.status_code == 200, f"list: {response.status_code} {response.text[:300]}"
    return response.parse(SqlTokenListResponse)


@pytest.mark.requires_seed("admin_operator", "dev_lead")
@pytest.mark.reliability
def test_token_create_list_remove_round_trip(
    admin_operator_session: PersonaSession, stand_manifest: Manifest
) -> None:
    client = admin_operator_session.client
    holder = stand_manifest.fixture("dev_lead")
    label = scratch.scratch_name("sql-token")

    created = client.post(TOKENS, json_body=_create_body(holder.uuid, label, 30))
    assert created.status_code == 201, f"create: {created.status_code} {created.text[:300]}"
    token = created.parse(CreatedSqlToken)
    token_id = scratch.track(TOKENS, "token_id", token.token_id)
    token_path = authenticator_path(f"/v1/sql-tokens/{token_id}")
    try:
        assert token.label == label
        assert token.person_id == holder.uuid
        assert token.token, "the creation response did not carry the token"

        entry = next(
            (e for e in _listed(admin_operator_session).items if e.token_id == token_id), None
        )
        assert entry is not None, "the created token is not listed"
        assert entry.label == label
        assert entry.person.person_id == holder.uuid
        assert entry.created_by.person_id == stand_manifest.fixture("admin_operator").uuid
        assert entry.expires_at == token.expires_at

        assert token.token not in client.get(TOKENS).text, "the list carries the token itself"

        removed = client.delete(token_path)
        assert removed.status_code == 204, f"remove: {removed.status_code} {removed.text[:300]}"

        assert token_id not in {e.token_id for e in _listed(admin_operator_session).items}, (
            "the token is still listed after a 204 remove"
        )

        gone = client.delete(token_path)
        assert gone.status_code == 404, (
            f"removing an already-removed token answered {gone.status_code}, expected 404: "
            f"{gone.text[:300]}"
        )
        assert gone.parse(ProblemDocument).status == 404
    finally:
        client.delete(token_path)


@pytest.mark.requires_seed("dev_lead")
@pytest.mark.security
def test_a_non_admin_cannot_create_a_token(
    lead_session: PersonaSession, stand_manifest: Manifest
) -> None:
    holder = stand_manifest.fixture("dev_lead")

    response = lead_session.client.post(
        TOKENS, json_body=_create_body(holder.uuid, scratch.scratch_name("sql-token"))
    )

    assert response.status_code == 403, (
        f"create answered {response.status_code} to a caller without the admin grant: "
        f"{response.text[:300]}"
    )
    assert response.parse(ProblemDocument).status == 403


@pytest.mark.requires_seed("dev_lead")
@pytest.mark.security
def test_a_non_admin_cannot_list_tokens(lead_session: PersonaSession) -> None:
    response = lead_session.client.get(TOKENS)

    assert response.status_code == 403, (
        f"list answered {response.status_code} to a caller without the admin grant: "
        f"{response.text[:300]}"
    )
    assert response.parse(ProblemDocument).status == 403


@pytest.mark.requires_seed("dev_lead")
@pytest.mark.security
def test_a_non_admin_cannot_remove_a_token(lead_session: PersonaSession) -> None:
    response = lead_session.client.delete(
        authenticator_path(f"/v1/sql-tokens/{scratch.UNKNOWN_ID}")
    )

    assert response.status_code == 403, (
        f"remove answered {response.status_code} to a caller without the admin grant: "
        f"{response.text[:300]}"
    )
    assert response.parse(ProblemDocument).status == 403


@dataclass(frozen=True)
class PersonalToken:
    token: str
    token_id: str


@pytest.fixture
def instance_token() -> str:
    candidates = candidate_env_files(_REPO_ROOT, os.environ)
    env_file = next((path for path in candidates if path.is_file()), None)
    stand_env = parse_env_file(env_file) if env_file else {}
    if stand_env.get("SQL_API_ENABLED", "").strip().lower() != "true":
        pytest.skip("the stand has the SQL API off: bring it up with SQL_API_ENABLED=true")
    token = stand_env.get("SQL_API_TOKEN", "").strip()
    assert token, f"the stand has the SQL API on but {env_file} holds no SQL_API_TOKEN"
    return token


@pytest.fixture
def personal_token(
    admin_operator_session: PersonaSession, stand_manifest: Manifest
) -> Iterator[PersonalToken]:
    client = admin_operator_session.client
    holder = stand_manifest.fixture("dev_lead")
    created = client.post(
        TOKENS, json_body=_create_body(holder.uuid, scratch.scratch_name("sql-token"), 1)
    )
    assert created.status_code == 201, f"create: {created.status_code} {created.text[:300]}"
    token = created.parse(CreatedSqlToken)
    token_id = scratch.track(TOKENS, "token_id", token.token_id)
    try:
        yield PersonalToken(token.token, token_id)
    finally:
        client.delete(authenticator_path(f"/v1/sql-tokens/{token_id}"))


def _ask(client: ApiClient, token: str) -> ApiResponse:
    return client.post(
        SQL_QUERY, json_body=READ_ONLY_QUERY, headers={"Authorization": f"Bearer {token}"}
    )


def _query(client: ApiClient, token: str) -> int:
    return _ask(client, token).status_code


def _rows(client: ApiClient, token: str) -> object:
    response = _ask(client, token)
    assert response.status_code == 200, f"query: {response.status_code} {response.text[:300]}"
    body = response.json()
    assert isinstance(body, dict), f"query answered a non-object body: {response.text[:300]}"
    return body["rows"]


@pytest.mark.requires_seed("admin_operator", "dev_lead")
@pytest.mark.versatility
def test_a_personal_token_returns_the_rows_the_instance_token_does(
    api_client: ApiClient, instance_token: str, personal_token: PersonalToken
) -> None:
    assert personal_token.token.startswith("isql_")

    assert (
        _rows(api_client, personal_token.token) == _rows(api_client, instance_token) == [{"one": 1}]
    )


@pytest.mark.requires_seed("admin_operator", "dev_lead")
@pytest.mark.security
def test_a_removed_token_gets_401_within_the_cache_window(
    admin_operator_session: PersonaSession,
    api_client: ApiClient,
    instance_token: str,
    personal_token: PersonalToken,
) -> None:
    assert _query(api_client, personal_token.token) == 200

    removed = admin_operator_session.client.delete(
        authenticator_path(f"/v1/sql-tokens/{personal_token.token_id}")
    )
    assert removed.status_code == 204, f"remove: {removed.status_code} {removed.text[:300]}"

    deadline = time.monotonic() + REVOCATION_DEADLINE_S
    status = _query(api_client, personal_token.token)
    while status != 401 and time.monotonic() < deadline:
        time.sleep(1)
        status = _query(api_client, personal_token.token)

    assert status == 401, (
        f"the removed token still answered {status} after {REVOCATION_DEADLINE_S:.0f} s"
    )
    assert _query(api_client, instance_token) == 200


@pytest.mark.security
def test_an_unknown_well_formed_token_gets_401(api_client: ApiClient, instance_token: str) -> None:
    assert _query(api_client, UNKNOWN_TOKEN) == 401
