"""The personal SQL token admin API behind `/api/authenticator/v1/sql-tokens`.

    POST   create 201, the token shown once · 403 without the admin grant
    GET    list 200 naming the holder · 403 without the admin grant
    DELETE remove 204, then 404 · 403 without the admin grant

Admin is the `admin` row in `identity.person_roles`, which the seed gives to the
admin operator alone, so every non-admin case asks as a lead. The 401 half is in
`test_gateway.py`, swept over every operation at once.

A created token is removed in the test that created it, and registered with
`scratch` so a leak fails the session.
"""

from __future__ import annotations

import pytest
from insight_stand import Manifest, PersonaSession, authenticator_path

from .. import scratch
from ..schemas import CreatedSqlToken, ProblemDocument, SqlTokenListResponse

TOKENS = authenticator_path("/v1/sql-tokens")


def _create_body(person_id: str, label: str, lifetime_days: int | None = None) -> dict[str, object]:
    body: dict[str, object] = {"person_id": person_id, "label": label}
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
    """`POST` 201 → the list names the holder → `DELETE` 204 → it is gone."""
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
    """The gate comes before the lookup, so the answer is 403 and not 404."""
    response = lead_session.client.delete(
        authenticator_path(f"/v1/sql-tokens/{scratch.UNKNOWN_ID}")
    )

    assert response.status_code == 403, (
        f"remove answered {response.status_code} to a caller without the admin grant: "
        f"{response.text[:300]}"
    )
    assert response.parse(ProblemDocument).status == 403
